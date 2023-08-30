import { initServices, MonacoLanguageClient } from "monaco-languageclient";

await initServices({ debugLogging: true });

const client = new MonacoLanguageClient({
    name: "Test Language Client",
    clientOptions: {
    },
});

await client.start();

console.log(`Client running: ${client.isRunning()}`);
