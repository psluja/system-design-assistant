/** Trigger a browser download of `content` as a file named `filename` with the given MIME type. The one place
 *  the blob → object-URL → anchor-click → revoke dance lives (it was inlined at every export site). */
export function downloadFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
