/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

"use strict";

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles, Breakpoint} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename} from 'path';

import {FirefoxSession} from './ffSession';

/**
 * This interface should always match the schema found in the firefox-debug extension manifest.
 */
export interface LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;

	webRoot?: string;
	runtimeExecutable?: string;
	port?: number;
	profileDir?: string;
	logEnabled?: boolean;
}

class PromiseCapability<T> {
	public promise: Promise<T>;
	public resolve: (T) => void;
	public reject: (any) => void;
	public constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

class FirefoxDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1000;

	// maps from sourceFile to array of Breakpoints
	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();
	private _breakPointsIds = new Map<string, string[]>();

	private _pausedCapability = new PromiseCapability<any>();
	private _resumeAllowedPromise = this._pausedCapability.promise;

	private _pendingSourceCapabilities: any = Object.create(null);
	private _sourcePromises: any = Object.create(null);

	private _variableHandles = new Handles<string>();

	private _session = new FirefoxSession();

	private _stopOnEntry: boolean;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);

		this._session = new FirefoxSession();
		this._session._onOutput = (s: string, category?: string): void => {
			this.sendEvent(new OutputEvent(s + '\n', category || 'stdout'));
		};
		this._session._onNotification = (topic: string, args: any): void => {
			this.onFirefoxNotification(topic, args);
		};
	}

	private resume(resumeLimit?: string): void {
		this._resumeAllowedPromise.then((_) => {
			this._pausedCapability = new PromiseCapability<any>();
			this._resumeAllowedPromise = this._pausedCapability.promise;
			this._session.resume(resumeLimit);
		});
	}

	private onFirefoxNotification(topic: string, args: any): void {
		switch (topic) {
			case 'paused':
				this._pausedCapability.resolve(args.reason);
				if (args.reason === 'attached') {
					if (this._stopOnEntry) {
						// we stop on the first line
						this.sendEvent(new StoppedEvent("entry", FirefoxDebugSession.THREAD_ID));
					} else {
						// we just start to run until we hit a breakpoint or an exception
						this.resume();
					}
					return;
				}
				// TODO
				this.sendEvent(new StoppedEvent("debugger", FirefoxDebugSession.THREAD_ID));
				return;
			case 'source':
				var path = args.path;
				if (!this._pendingSourceCapabilities[path]) {
					this._sourcePromises[path] = Promise.resolve(args.id);
				} else {
					this._pendingSourceCapabilities[path].resolve(args.id);
				}
				return;
		}
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this._stopOnEntry = false; //args.stopOnEntry;

		this._session.launch(args);
		this.sendResponse(response);
	}

	private getSourceId(path: string): Promise<string> {
		if (this._sourcePromises[path]) {
			return this._sourcePromises[path];
		}
		var capability = new PromiseCapability<string>();
		this._sourcePromises[path] = capability.promise;
		this._pendingSourceCapabilities[path] = capability;
		capability.promise.then((_) => {
			delete this._pendingSourceCapabilities[path];
		}, (_) => {
			delete this._pendingSourceCapabilities[path];
		});
		return capability.promise;
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		var path = args.source.path;
		var clientLines = args.lines;
		var sourceId;
		this._resumeAllowedPromise = Promise.all([this.getSourceId(path), this._resumeAllowedPromise]).then((results) => {
			sourceId = results[0];
			var oldBreakpointsIds = this._breakPointsIds[path];
			if (oldBreakpointsIds && oldBreakpointsIds.length > 0) {
				return this._session.removeBreakpoints(oldBreakpointsIds);
			}
		}).then(() => {
			var lines = new Array<number>();
			// verify breakpoint locations
			for (var i = 0; i < clientLines.length; i++) {
				var l = this.convertClientLineToDebugger(clientLines[i]);
				lines.push(l);
			}

			return this._session.addBreakpoints(sourceId, lines).then((items) => {
				var breakpoints = new Array<Breakpoint>();
				var breakpointsIds = new Array<string>();
				items.forEach((item) => {
					var verified = !!item.id;
					if (verified) {
						breakpointsIds.push(item.id)
					}
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(item.line));
					bp.id = this._breakpointId++;
					breakpoints.push(bp);
				});
				this._breakPoints[path] = breakpoints;
				this._breakPointsIds[path] = breakpointsIds;

				return breakpoints;
			});
		}).then((breakpoints) => {
			// send back the actual breakpoint positions
			response.body = {
				breakpoints: breakpoints
			};
			this.sendResponse(response);
		});
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// return the default thread
		response.body = {
			threads: [
				new Thread(FirefoxDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this._session.getStackTrace((<any>args).startFrame, args.levels).then(
				(stack: Array<{name: string, source: string, line: number}>) => {
			const frames = new Array<StackFrame>();
			stack.forEach((f: {name: string, source: string, line: number}, index: number) => {
				var path = this.convertDebuggerPathToClient(f.source);
				frames.push(new StackFrame(
						index,
						`${f.name}(${index})`,
						new Source(basename(path), path),
						this.convertDebuggerLineToClient(f.line),
						0)
				);
			});
			response.body = {
				stackFrames: frames
			};
			this.sendResponse(response);
		});
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const frameReference = args.frameId;
		this._session.getScopes(frameReference).then((items) => {
			const scopes = new Array<Scope>();
			items.forEach((item) => {

				scopes.push(new Scope(item.type, this._variableHandles.create(item.id), item.type === 'Global'));
			});

			response.body = {
				scopes: scopes
			};
			this.sendResponse(response);
		});
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const id = this._variableHandles.get(args.variablesReference);
		this._session.getVariables(id).then((items) => {
			const variables = [];
			items.forEach((item) => {
				variables.push({
					name: item.name,
					value: item.value.display,
					variablesReference: !item.value.id ? 0 : this._variableHandles.create(item.value.id)
				});
			});
			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		}).catch(_ => {
			response.body = {
				variables: []
			};
			this.sendResponse(response);
		});
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.resume();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.resume('next');
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.resume('step');
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.resume('finish');
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		this._session.evaluate(args.expression, args.frameId).then((result) => {
			response.body = {
				result: result.display,
				variablesReference: !result.id ? 0 : this._variableHandles.create(result.id)
			};
			this.sendResponse(response);
		}, (reason) => {
			response.body = {
				result: 'eval error: ' + reason,
				variablesReference: 0
			};
			this.sendResponse(response);
		});
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this._pausedCapability.reject('stopping');
		Object.keys(this._pendingSourceCapabilities).forEach((key) => {
			if (this._pendingSourceCapabilities[key]) {
				this._pendingSourceCapabilities.reject('stopping');
			}
		});
		this.sendEvent(new OutputEvent('stopping'));

		this._session.stop();
		this._session = null;

		this.sendResponse(response);
		this.shutdown();
	}

	protected convertClientPathToDebugger(path: string): string {
		return this._session.urlHelper.convertToWeb(path);
	}

	protected convertDebuggerPathToClient(path: string): string {
		return this._session.urlHelper.convertToLocal(path);
	}}

DebugSession.run(FirefoxDebugSession);
