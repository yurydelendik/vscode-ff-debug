# VS Code Firefox Debug

TBD

## Using Firefox Debug

* Install the **Firefox Debug** extension in VS Code.
* TBD
* Switch to the debug viewlet and press the gear dropdown.
* Select the debug environment "Firefox Debug".
* Press the green 'play' button to start debugging.

TBD

## Build and Run


* Clone the project [https://github.com/yurydelendik/vscode-ff-debug.git](https://github.com/yurydelendik/vscode-ff-debug.git)
* Open the project folder in VS Code.
* Press `F5` to build and launch Firefox Debug in another VS Code window. In that window:
  * Open a new workspace, create a new 'program' file `readme.md` and enter several lines of arbitrary text.
  * Switch to the debug viewlet and press the gear dropdown.
  * Select the debug environment "Firefox Debug".
  * Press `F5` to start debugging.

## Developing

* Clone the project [https://github.com/yurydelendik/vscode-ff-debug.git](https://github.com/yurydelendik/vscode-ff-debug.git)
* "npm install"
* Compile code by running "npm run-script compile"
* Run vscode with extension "code --extensionDevelopmentPath=`pwd`"

(code is `alias code="/Applications/Visual\ Studio\ Code.app/Contents/MacOS/Electron"`)

In experimental env:

* Create index.html, e.g.:


```
<script>
   function test() {
     var i = 0;
     var j = i + 1;
     var q = j * 2;
     var obj = {k: 12, q: q};
     console.log(toStr(obj));
   }

   function toStr(o) {
      var s = '' + o, t = '';
      for (var i = 0; i < s.length; i++) {
        t = s[i] + t;
      }
      debugger;
      return t;
   }

   setInterval(test, 4000);
</script>
```

* and .vscode/launch.json:

```
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Firefox-Debug",
      "type": "firefox",
      "request": "launch",
      "runtimeExecutable": "/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox",
      "port": 6000,
      "program": "${workspaceRoot}/index.html",
      "profileDir": "${workspaceRoot}/.firefoxProfile",
      "stopOnEntry": false
    },
    {
      "name": "Firefox-Debug-HTTP",
      "type": "firefox",
      "request": "launch",
      "runtimeExecutable": "/Applications/FirefoxDeveloperEdition.app/Contents/MacOS/firefox",
      "port": 6001,
      "program": "http://localhost:8000/index.html",
      "webRoot": "${workspaceRoot}",
      "profileDir": "${workspaceRoot}/.firefoxProfile",
      "stopOnEntry": false
    }
   ]
}
```

* Hit debug icon
* Run 'Firefox-Debug'
* Allow debugger connection (it is about 5 seconds).
