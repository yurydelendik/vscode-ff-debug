"use strict";

import {connect, Socket} from 'net';

export class FirefoxProtocol {
  private _client: Socket;
  private _state: string;

  public constructor() {
    this._state = 'disconnected';
  }

  public connect(port: number): Promise<void> {
    this._state = 'connecting';
    return new Promise<void>((resolve, reject) => {
      var client: Socket = connect(port, () => {
        console.log('connected to firefox');
        this._state = 'connected';
        this.setupSocket(client);
        resolve();
      });
    });
  }

  protected onExecuteCommand(body: any): void {

  }

  protected onDisconnect(): void  {

  }

  protected sendResponse(body: any): void {
    var buffer = new Buffer(JSON.stringify(body));
    var headerBytes = new Buffer(buffer.length + ':');
    var data = Buffer.concat([headerBytes, buffer]);
    this._client.write(data);
  }

  protected setupSocket(client: Socket): void  {
    var ffBuffer = new Buffer(0);
    client.on('data', (data) => {
      var newBuffer = Buffer.concat([ffBuffer, data], ffBuffer.length + data.length);
      var pos = 0;
      var parseResult;
      while (pos < newBuffer.length &&
             (parseResult = this.parseFirefoxPacket(newBuffer, pos))) {
        this.onExecuteCommand(parseResult.body);
        pos = parseResult.lastPos;
      }
      if (pos < newBuffer.length) {
        ffBuffer = newBuffer.slice(pos);
      } else if (ffBuffer.length > 0) {
        ffBuffer = new Buffer(0);
      }
    });

    client.on('end', () => {
      client.end();
      console.log('client disconnected');
      this._state = 'disconnected';
      this.onDisconnect();
    });
    this._client = client;
  }

  private parseFirefoxPacket(buffer: Buffer, pos: number): {lastPos: number; body: Object} {
    var i = pos;
    // find next ":"
    while (i < buffer.length && buffer[i] >= 0x30 && buffer[i] <= 0x39) {
      i++;
    }
    if (i >= buffer.length) {
      return null; // need headers
    }
    if (i === pos || buffer[i] !== 0x3a) {
      throw new Error('Invalid packet header');
    }
    var contentLength = +buffer.toString('utf8', pos, i);
    i++;
    if (i + contentLength > buffer.length) {
      return null; // need entire packet data
    }
    var body = buffer.toString('utf8', i, i + contentLength);
    return {
      lastPos: i + contentLength,
      body: body === '' ? undefined : JSON.parse(body)
    };
  }
}