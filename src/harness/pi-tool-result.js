export function createToolResult(text, state) {
  return {
    content: [{ type: "text", text }],
    details: { state },
  };
}
