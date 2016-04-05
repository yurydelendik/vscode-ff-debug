"use strict";

import {FirefoxProtocol} from './ffProtocol';
import {IURLHelper, LocalURLHelper, HttpURLHelper} from './ffUrlHelper';

import {spawn, ChildProcess} from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const DefaultPort: number = 9223;

class FirefoxProtocolImpl extends FirefoxProtocol {
  private _session: FirefoxSession;
  public contextActor: ContextActor;

  private _map: Map<string, Actor>;

  public constructor(program: string, urlHelper: IURLHelper, session: FirefoxSession) {
    super();
    this._session = session;
    this._map = Object.create(null);
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

  public relayResponse(body: any): void  {
    this.sendResponse(body);
  }

  public log(s: string, category?: string): void {
    this._session._onOutput(s, category);
  }

  public notifySession(topic: string, args: any): void {
    this._session._onNotification(topic, args);
  }
}

class ActorRequest {
  public promise: Promise<any>;
  private _resolve: (any) => void;
  private _reject: (any) => void;

  public constructor(public body: any) {
    this.promise = new Promise<any>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }
  public respond(response: any): void  {
    if (!response.error) {
      this._resolve(response);
    } else {
      this._reject(new Error(response.error + ': ' + JSON.stringify(response)));
    }
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

  public processCommand(body: any): boolean {
    if (body.type) {
      return this.processNotification(body);
    }
    if (body.error) {
      return this.processError(body);
    }
    return this.processResponse(body);
  }

  protected processResponse(body: any): boolean {
    if (!this._processing) {
      return false;
    }
    this._processing.respond(body);
    if (this._queue.length > 0) {
      this._processing = this._queue.shift();
      this.protocol.relayResponse(this._processing.body);
    } else {
      this._processing = null;
    }
    return true;
  }

  protected processNotification(body: any): boolean  {
    return false;
  }

  protected processError(body: any): boolean {
    return false;
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
      this.log('ERR:' + e);
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
    this.protocol.log(message.arguments.join(','), category);
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
  private _evaluateCallbacks: {
    resolve: (string) => void,
    reject: (any) => void
  };

  public constructor(name: string, protocol: FirefoxProtocolImpl) {
    super(name, protocol);

    this.sendMessage({type: 'attach'});
    this.sendRequest({type: 'sources'}).then(function () {
      // we got all sources
    });
  }

  private formatGrip(value: any): Promise<string> {
    if (typeof value !== 'object' || value === null) {
      return Promise.resolve('' + value);
    }
    return Promise.resolve(`[${value.class}]`); // TODO
  }

  private formatReturnValue(value: any): Promise<string>  {
    if (value.terminated) {
      return Promise.resolve('(terminated)');
    }
    if (value.throw) {
      return this.formatGrip(value.throw).then((s: string) => {
        return `(error: ${s})`;
      });
    }
    return this.formatGrip(value.return);
  }

  public processNotification(body: any): boolean {
    switch (body.type) {
      case 'paused':
        var reason = body.why && body.why.type;
        if (reason === 'clientEvaluated') {
          this.formatReturnValue(body.why.frameFinished).then(
            this._evaluateCallbacks.resolve, this._evaluateCallbacks.reject);
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
        // TODO shall we do something here?
        return true;
    }
    return false;
  }

  public processError(body: any): boolean {
    switch (body.error) {
      case 'unknownFrame':
      case 'notDebuggee':
      case 'wrongState':
        if (this._evaluateCallbacks) {
          this._evaluateCallbacks.reject(new Error(body.message));
          return true;
        }
        return false;
    }
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

  public evaluate(expr: string, frameId?: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.sendMessage({ "type":"clientEvaluate", "expression":expr, "frame": frameId || 0 });
      this._evaluateCallbacks = {
        resolve: resolve,
        reject: reject
      };
    });
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
user_pref("devtools.debugger.remote-enabled", true);
`);
  }

  public launch(args: {runtimeExecutable?: string; port?: number; program: string;
                       profileDir?: string, webRoot?: string}): void {
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

  public evaluate(expr: string, frameId?: number): Promise<string> {
    return this._protocol.contextActor.evaluate(expr, frameId);
  }
}