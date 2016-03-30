"use strict";

import {FirefoxProtocol} from './ffProtocol';

import {spawn, ChildProcess} from 'child_process';
import * as path from 'path';

const DefaultPort: number = 9223;

class SessionFirefoxProtocol extends FirefoxProtocol {
  private _program: string;
  private _session: FirefoxSession;

  public constructor(program: string, session: FirefoxSession) {
    super();
    this._program = program;
    this._session = session;
  }

  protected onExecuteCommand(body: any): void {
    this._session._onOutput(JSON.stringify(body));
  }
}

export class FirefoxSession {
  private _process: ChildProcess;
  private _protocol: SessionFirefoxProtocol;

  public _onOutput: (s: string) => void;

  public constructor() {

  }

  public launch(args: {runtimeExecutable?: string; port?: number; program: string}): void {
    var processArgs = [];
    processArgs.push('--start-debugger-server', args.port || DefaultPort);
    processArgs.push('--no-remote');
    processArgs.push(args.program);

    const firefoxPath = args.runtimeExecutable;
    if (firefoxPath) {
      this._process = spawn(firefoxPath, processArgs, {
        detached: true,
        stdio: ['ignore']
      });
    }
    this.attach(args.port || DefaultPort, args.program);
  }

  public attach(port: number, program: string): void {
    this._protocol = new SessionFirefoxProtocol(program, this);
    setTimeout(() => {
      this._protocol.connect(port)
    }, 5000);
  }
}