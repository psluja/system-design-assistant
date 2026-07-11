import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './app';
import { ErrorBoundary } from './error-boundary';
import './theme.css';

// A render crash anywhere in App must NOT blank the whole page (the "everything vanished, reload to fix" bug) — the
// ErrorBoundary catches it, keeps the design (it lives in Studio/IndexedDB), and offers a non-destructive Recover.
// ReactFlowProvider HOISTS the React Flow store above App so App can call store hooks (useUpdateNodeInternals — the
// port-slide handle re-measure) at its top level, outside the <ReactFlow> subtree. The same store still backs the
// canvas's <ReactFlow>, so nothing about the graph rendering changes.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </ErrorBoundary>,
);
