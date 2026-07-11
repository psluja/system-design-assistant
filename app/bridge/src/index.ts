import { startBridge } from './bridge.ts';

// CLI entry: `node app/bridge/src/index.ts [port]` (or `PORT=7777 …`). Point any MCP client at
// http://localhost:<port>/mcp, open the SDA web app, click “Link AI” — the AI now drives your canvas.
const port = Number(process.argv[2] ?? process.env.PORT ?? 7777);

void startBridge(port).then((b) => {
  process.stderr.write(
    [
      '',
      '  SDA AI bridge is up (loopback only).',
      `  1) Point your MCP client at:  http://localhost:${b.port}/mcp?token=${b.token}`,
      '  2) Open the SDA web app, click “Link AI”, and paste this token:',
      `        ${b.token}`,
      '  The AI now edits your live canvas. Ctrl+C to stop.',
      '',
    ].join('\n'),
  );
  const stop = (): void => void b.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
