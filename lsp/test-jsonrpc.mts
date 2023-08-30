import * as cp from "child_process";
import * as rpc from "vscode-jsonrpc/node";

let childProcess = cp.spawn(
  "typescript-language-server",
  ["--stdio"] /* , {
    // env: process.env,
//   shell: true,
} */,
);

// Use stdin and stdout for communication:
let connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(childProcess.stdout),
  new rpc.StreamMessageWriter(childProcess.stdin),
);

connection.trace(rpc.Trace.Verbose, console);

let notification = new rpc.NotificationType<string>("testNotification");

connection.listen();

connection.sendNotification(notification, "Hello World");

console.log(`Responses pending: ${connection.hasPendingResponse()}`);

void (async function () {
  // Send JSON-RPC request to initialize language server
  let request = new rpc.RequestType<object, object, object>("initialize");

  let initParams = {
    processId: process.pid,
    rootPath: process.cwd(),
    capabilities: {},
    workspaceFolders: null,
  };

  const result = await connection.sendRequest(request, initParams);

  console.log(JSON.stringify(result, null, 2));

  // Send JSON-RPC notification to exit language server
  let exitNotification = new rpc.NotificationType0("exit");

  connection.sendNotification(exitNotification);
})();

console.log(`Responses pending: ${connection.hasPendingResponse()}`);

connection.end();

process.exit(0);
