/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

import {FirefoxProtocol} from './ffProtocol';
import {IURLHelper, LocalURLHelper, HttpURLHelper} from './ffUrlHelper';

import {spawn, ChildProcess} from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const DefaultPort: number = 9223;
const EnvironmentVariablesPrefix = 'env!';

export class ActorError extends Error {
	public body;
	public constructor(message, body) {
		super(message);
		this.body = body;
	}
}

export interface ResultVariable {
	display: string;
	id?: string;
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

class FirefoxProtocolImpl extends FirefoxProtocol {
	private _session: FirefoxSession;
	public contextActor: ContextActor;
	public urlHelper: IURLHelper;
	public logEnabled: boolean;

	private _map: Map<string, Actor>;

	public constructor(program: string, urlHelper: IURLHelper, session: FirefoxSession) {
		super();
		this._session = session;
		this.urlHelper = urlHelper;
		this._map = Object.create(null);
		this.logEnabled = false;
		this.addActor(new RootActor('root', this, program));
	}

	protected onExecuteCommand(body: any): void {
		if (!body || !body.from) return;
		var from = body.from;
		var actor = this._map[from];
		if (actor) {
			if (actor.processCommand(body))
				return;
		}
		this.log('Missed message: ' + JSON.stringify(body));
	}

	public addActor(actor: Actor): void  {
		this._map[actor.name] = actor;
	}

	public removeActor(actor: Actor): void {
		delete this._map[actor.name];
	}

	public relayResponse(body: any): void  {
		this.sendResponse(body);
	}

	public log(s: string): void {
		if (!this.logEnabled) {
			return;
		}
		this._session._onOutput(s);
	}

	public print(s: string, category: string): void {
		this._session._onOutput(s, category);
	}

	public notifySession(topic: string, args: any): void {
		this._session._onNotification(topic, args);
	}
}

class ActorRequest {
	private _capability: PromiseCapability<any>;

	public constructor(public body: any) {
		this._capability = new PromiseCapability<any>();
	}

	public get promise(): Promise<any> {
		return this._capability.promise;
	}

	public respond(response: any): void {
		this._capability.resolve(response);
	}

	public fail(response: any): void {
		this._capability.reject(new ActorError('Actor error', response));
	}
}

class Actor {
	private _processing: ActorRequest;
	private _queue: Array<ActorRequest>;

	protected notImplemented: (any)=>void;

	public constructor(public name: string, public protocol: FirefoxProtocolImpl) {
		this._processing = null;
		this._queue = [];
		this.notImplemented = (body: any) => {
			this.log('NI: ' + JSON.stringify(body));
		};
	}

	public executeOnce<T>(action: ()=>Promise<T>): Promise<T> {
		this.protocol.addActor(this);
		return action().then((result: T) => {
			this.protocol.removeActor(this);
			return result;
		}, (reason) => {
			this.protocol.removeActor(this);
			throw reason;
		});
	}

	public processCommand(body: any): boolean {
		if (body.type) {
			return this.processNotification(body);
		}
		if (body.error) {
			return this.processError(body);
		}
		return this.processResponse(body);
	}

	private sendNext(): void {
		if (this._queue.length > 0) {
			this._processing = this._queue.shift();
			this.protocol.relayResponse(this._processing.body);
		} else {
			this._processing = null;
		}
	}

	protected processResponse(body: any): boolean {
		if (!this._processing) {
			return false;
		}
		this._processing.respond(body);
		this.sendNext();
		return true;
	}

	protected processNotification(body: any): boolean {
		return false;
	}

	protected processError(body: any): boolean {
		if (!this._processing) {
			return false;
		}
		this._processing.fail(body);
		this.sendNext();
		return true;
	}

	public sendRequest(body: any): Promise<any>  {
		if (body.to === undefined) {
			body.to = this.name;
		}
		var request = new ActorRequest(body);
		if (this._processing) {
			this._queue.push(request);
		} else {
			this._processing = request;
			this.protocol.relayResponse(request.body);
		}
		return request.promise.catch((e) => {
			var msg = e.message + (e instanceof ActorError ? ',' + JSON.stringify(e.body) : '');
			this.log('sendRequest failed:' + msg);
			throw e;
		});
	}

	public sendMessage(body: any): void {
		if (body.to === undefined) {
			body.to = this.name;
		}
		this.protocol.relayResponse(body);
	}

	public log(s: string): void {
		this.protocol.log('actor/' + this.name + ': ' + s);
	}
}

enum SessionState {
	INITIALIZATION,
	SELECT_TAB,
	READY
}

class RootActor extends Actor {
	private _tabState: SessionState;
	private _program: string;
	private _tabInfo: {actor: string; consoleActor: string};

	public constructor(name: string, protocol: FirefoxProtocolImpl, program: string) {
		super(name, protocol);
		this._tabState = SessionState.INITIALIZATION;
		this._program = program;
	}

	private init(body: any): void {
		this.log('Initialized');
		this._tabState = SessionState.SELECT_TAB;
		this.sendRequest({type: 'listTabs'}).then((tabs) => {
			this.selectTab(tabs);
			this._tabState = SessionState.READY;
		});
	}

	private selectTab(body: any): void {
		var tabs: Array<any> = body.tabs;
		tabs.forEach((tab) => {
			if (tab.url === this._program) {
				this._tabInfo = tab;
			}
		});
		if (!this._tabInfo) {
			throw new Error('tab not found');
		}
		this.log('Tab ' + this._program +  ' found.');
		this.protocol.addActor(new ConsoleActor(this._tabInfo.consoleActor, this.protocol));
		this.protocol.addActor(new TabActor(this._tabInfo.actor, this.protocol));
	}

	public processCommand(body: any): boolean {
		if (this._tabState === SessionState.INITIALIZATION) {
			this.init(body);
			return true;
		}
		return super.processCommand(body);
	}
}

class ConsoleActor extends Actor {
	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);

		var listenFor: string[] = ['PageError', 'ConsoleAPI'];
		this.sendRequest({type: 'startListeners', listeners: listenFor}).then(() => {
			this.log('listeners');
		});
		this.sendRequest({type: 'getCachedMessages', messageTypes: listenFor}).then(function (body) {
			this.log('messages');
			var messages: Array<any> = body.messages;
			messages.forEach((message) => this.printMessage(message, message._type));
		});
	}

	public processNotification(body: any) {
		switch (body.type) {
			case 'consoleAPICall':
				this.printMessage(body.message, '_ConsoleAPI');
				return true;
			case 'pageErrorCall':
				this.printMessage(body.message, '_PageError');
				return true;
		}
		return false;
	}

	private printMessage(message: any, type: string): void {
		var category = message.level === 'error' ? 'stderr' :
			message.level === 'warning' ? 'console' : 'stdout';
		this.protocol.print(message.arguments.join(','), category);
	}
}

class TabActor extends Actor {
	private _contextActor: ContextActor;

	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);

		this.sendMessage({type: 'attach'});
	}

	public processNotification(body: any) {
		switch (body.type) {
			case 'tabAttached':
				var threadActor = body.threadActor;
				this._contextActor = new ContextActor(threadActor, this.protocol);
				this.protocol.contextActor = this._contextActor;
				this.protocol.addActor(this._contextActor);

				this.log('context is defined.');
				return true;
			case 'frameUpdate':
				// TODO
				return true;
		}
		return false;
	}
}

class ContextActor extends Actor {
	private _evaluateCapabilty: PromiseCapability<ResultVariable>;

	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);

		this._evaluateCapabilty = null;

		this.sendMessage({type: 'attach'});
		this.sendRequest({type: 'sources'}).then(function () {
			// we got all sources
		});
	}

	private formatGrip(value: any): string {
		if (typeof value !== 'object' || value === null) {
			return JSON.stringify(value);
		}
		switch (value.type) {
			case 'null':
			case 'undefined':
			case 'Infinity':
			case '-Infinity':
			case 'NaN':
			case '-0':
				return value.type;
			case 'longString':
				return value.initial; // TODO
		}
		return `[object ${value.class}]`;
	}

	private getActor(value: any): string {
		return typeof value === 'object' && value !== null && value.type === 'object' ?
			value.actor : undefined;
	}

	private formatReturnValue(value: any): ResultVariable  {
		if (value.terminated) {
			return {display: '(terminated)'};
		}
		if (value.throw) {
			var s = this.formatGrip(value.throw);
			return {display: `(error: ${s})`, id: this.getActor(value.throw)};
		}
		return {display: this.formatGrip(value.return), id: this.getActor(value.return)};
	}

	public processNotification(body: any): boolean {
		switch (body.type) {
			case 'paused':
				var reason = body.why && body.why.type;
				if (reason === 'clientEvaluated') {
					this._evaluateCapabilty.resolve(
						this.formatReturnValue(body.why.frameFinished));
					return true;
				}
				this.log('paused: ' + reason);
				this.protocol.notifySession('paused', {reason: reason});
				return true;
			case 'resumed':
				this.log('resumed');
				return true;
			case 'newGlobal':
				// TODO shall we do something here?
				return true;
			case 'newSource':
				var url = body.source.url;
				if (!url) {
					return true; // ignoring scripts without url
				}
				var path = this.protocol.urlHelper.convertToLocal(url);
				if (!path) {
					return true; // ignoring non-project scripts
				}
				this.protocol.notifySession('source', {
					path: path, url: url, id: body.source.actor})
				return true;
		}
		return false;
	}

	public processError(body: any): boolean {
		switch (body.error) {
			case 'unknownFrame':
			case 'notDebuggee':
			case 'wrongState':
				if (this._evaluateCapabilty) {
					this._evaluateCapabilty.reject(new Error(body.message));
					return true;
				}
				return false;
		}
		return super.processError(body);
	}

	public resume(reason?: string): void {
		if (!reason) {
			this.sendMessage({type: 'resume'});
			return;
		}
		var resumeLimit = {
			type: reason
		};
		this.sendMessage({type: 'resume', resumeLimit: resumeLimit});
	}

	public getStackTrace(startFrame?: number, maxLevels?: number):
			Promise< Array<{name: string, source: string, line: number}> > {
		return this.sendRequest({type: 'frames', startFrame: startFrame, count: maxLevels}).then((body) => {
			var frames = body.frames;
			return frames.map((f, index: number) => {
				return {
					depth: index,
					name: f.callee.name,
					source: f.where.source.url,
					line: f.where.line
				};
			});
		});
	}

	public getScopes(frame: number): Promise< Array<{type: string, id: string}> > {
		return this.sendRequest({type: 'frames', startFrame: frame, count: 1}).then((body) => {
			var environment = body.frames[0].environment;

			var first = true;
			var result = new Array<{type: string, id: string}>();
			while (environment) {
				var parent = environment.parent;
				result.push({
					type: !parent ? 'Global' : first ? "Local" : "Closure",
					id: EnvironmentVariablesPrefix + environment.actor
				});
				first = false;
				environment = parent;
			}
			return result;
		});
	}

	private translateProperty(desc): ResultVariable {
		if (!('value' in desc)) {
			return {display: '(property)'};
		}
		return {display: this.formatGrip(desc.value), id: this.getActor(desc.value)};
	}

	private translateProperties(item, result: Array<{name: string, value: ResultVariable}>): void {
		Object.keys(item).forEach((key) => {
			result.push({name: key, value: this.translateProperty(item[key])});
		});
	}

	public getVariables(refId: string): Promise< Array<{name: string, value: ResultVariable}> > {
		if (refId.indexOf(EnvironmentVariablesPrefix) === 0) {
			var environment = new EnvironmentActor(refId.substring(EnvironmentVariablesPrefix.length), this.protocol);
			return environment.executeOnce(() => environment.getBindings()).then((body) => {
				var result = new Array<{name: string, value: ResultVariable}>();
				if (body.arguments) {
					body.arguments.forEach((item) => {
						this.translateProperties(item, result);
					});
				}
				if (body.variables) {
					this.translateProperties(body.variables, result);
				}
				return result;
			});
		} else {
			var objectGrip = new GripActor(refId, this.protocol);
			return objectGrip.executeOnce(() => objectGrip.getPrototypeAndProperties()).then((body) => {
				var result = new Array<{name: string, value: ResultVariable}>();
				this.translateProperties(body.ownProperties, result);
				if (body.prototype) {
					result.push({name: '__proto__', value: this.translateProperty(body.prototype)});
				}
				return result;
			});
		}
	}

	public evaluate(expr: string, frame?: number): Promise<ResultVariable> {
		if (frame === undefined) frame = 0; // FIXME if undefined, it must be global
		this._evaluateCapabilty = new PromiseCapability<ResultVariable>();
		this.sendRequest({type: 'frames', startFrame: frame, count: 1}).then((body) => {
			return this.sendMessage({
				"type": "clientEvaluate",
				"expression": expr,
				"frame": body.frames[0].actor
			});
		}).catch(this._evaluateCapabilty.reject);
		return this._evaluateCapabilty.promise;
	}

	public addBreakpoints(sourceId: string, lines: number[]): Promise< Array<{id: string, line: number}> > {
		var source = new SourceActor(sourceId, this.protocol);
		return source.executeOnce(() => {
			var promises = lines.map((line) => {
				return source.addBreakpoint(line);
			});
			return Promise.all(promises);
		});
	}

	public removeBreakpoints(ids: string[]): Promise<any> {
		var promise = Promise.resolve(undefined);
		ids.forEach((id) => {
			var breakpoint = new Breakpoint(id, this.protocol);
			promise = promise.then(() => {
				return breakpoint.executeOnce(() => breakpoint.remove());
			});
		});
		return promise;
	}
}

class EnvironmentActor extends Actor {
	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);
	}

	public getBindings(): Promise< {arguments?: Array<any>, variables?: any} > {
		return this.sendRequest({type: 'bindings'}).then(body => body.bindings);
	}
}

class GripActor extends Actor  {
	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);
	}

	public getPrototypeAndProperties(): Promise<{prototype?: any, ownProperties: any}> {
		return this.sendRequest({type: 'prototypeAndProperties'});
	}
}

class SourceActor extends Actor {
	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);
	}

	public addBreakpoint(line: number): Promise<{id: string, line: number}> {
		return this.sendRequest({type: 'setBreakpoint', location: {line: line}}).then((body) => {
			var actualLine = body.actualLocation ? body.actualLocation.line : line;
			var verified = !body.isPending;
			var actor = body.actor;
			return {id: actor, line: actualLine, verified: verified};
		}, (reason) => {
			return {id: undefined, line: line, verified: false};
		});
	}
}

class Breakpoint extends Actor {
	public constructor(name: string, protocol: FirefoxProtocolImpl) {
		super(name, protocol);
	}

	public remove(): Promise<any> {
		return this.sendRequest({type: 'delete'});
	}
}

export class FirefoxSession {
	private _process: ChildProcess;
	private _protocol: FirefoxProtocolImpl;

	public _onOutput: (s: string, category?: string) => void;
	public _onNotification: (typic: string, args: any) => void;
	public urlHelper: IURLHelper;

	public constructor() {

	}

	private ensureProfileDirExists(p: string): void {
		var exists = false;
		try {
			exists = fs.lstatSync(p).isDirectory();
		} catch (e) {}
		if (exists) return;
		fs.mkdirSync(p);
		fs.writeFileSync(path.join(p, 'prefs.js'), `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.debugger.remote-enabled", true);
`);
	}

	public launch(args: {runtimeExecutable?: string; port?: number; program: string;
											 profileDir?: string, webRoot?: string, logEnabled?: boolean}): void {
		var url: string = args.program;
		var urlHelper: IURLHelper;
		if (url.indexOf('://') < 0) {
			urlHelper = new LocalURLHelper();
			url = urlHelper.convertToWeb(url);
		} else {
			if (!args.webRoot) throw new Error('webRoot is not set');
			urlHelper = new HttpURLHelper(args.webRoot, url);
		}
		var port: number = args.port || DefaultPort;
		var processArgs = [];
		processArgs.push('--no-remote');
		if (args.profileDir) {
			this.ensureProfileDirExists(args.profileDir);
			processArgs.push('--profile', args.profileDir);
		}
		processArgs.push('--start-debugger-server', port);
		processArgs.push(url);

		const firefoxPath = args.runtimeExecutable;
		if (firefoxPath) {
			this._process = spawn(firefoxPath, processArgs, {
				detached: true,
				stdio: ['ignore']
			});
		}
		this.attach(port, url, urlHelper);
		this._protocol.logEnabled = !!args.logEnabled;
	}

	public attach(port: number, program: string, urlHelper: IURLHelper): void {
		this.urlHelper = urlHelper;
		this._protocol = new FirefoxProtocolImpl(program, urlHelper, this);
		setTimeout(() => {
			this._protocol.connect(port)
		}, 5000);
	}

	public stop(): void {
		this._process.kill();
	}

	public resume(reason?: string): void {
		this._protocol.contextActor.resume(reason);
	}

	public getStackTrace(startFrame?: number, maxLevels?: number): Promise< Array<{name: string, source: string, line: number}> > {
		return this._protocol.contextActor.getStackTrace(startFrame, maxLevels);
	}

	public getScopes(frame: number): Promise< Array<{type: string, id: string}> > {
		return this._protocol.contextActor.getScopes(frame);
	}

	public evaluate(expr: string, frame?: number): Promise<ResultVariable> {
		return this._protocol.contextActor.evaluate(expr, frame);
	}

	public getVariables(refId: string): Promise< Array<{name: string, value: ResultVariable}> > {
		return this._protocol.contextActor.getVariables(refId);
	}

	public addBreakpoints(sourceId: string, lines: number[]): Promise< Array<{id: string, line: number}> > {
		return this._protocol.contextActor.addBreakpoints(sourceId, lines);
	}

	public removeBreakpoints(ids: string[]): Promise<any> {
		return this._protocol.contextActor.removeBreakpoints(ids);
	}
}
