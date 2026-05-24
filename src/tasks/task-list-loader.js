const CHECKBOX_TASK_PATTERN =
  /^\s*(?:[-*]|\d+\.)\s+\[([ xX])\]\s+(\S+)(?:\s+P(\d+))?\s+(.+?)\s*$/;

export function parseTaskList(markdown) {
  const tasks = [];
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = CHECKBOX_TASK_PATTERN.exec(line);
    if (!match) {
      return;
    }

    tasks.push({
      id: match[2],
      title: match[4],
      priority:
        match[3] === undefined ? Number.POSITIVE_INFINITY : Number(match[3]),
      completed: match[1].toLowerCase() === "x",
      lineNumber: index + 1,
      raw: line,
    });
  });

  return tasks;
}
