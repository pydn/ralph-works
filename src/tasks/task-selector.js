export function selectNextTask(tasks, implementationStatus = {}) {
  const claimed = new Set(implementationStatus.claimedTaskIds ?? []);
  const completed = new Set(implementationStatus.completedTaskIds ?? []);

  return tasks
    .filter((task) => !task.completed)
    .filter((task) => !claimed.has(task.id))
    .filter((task) => !completed.has(task.id))
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.lineNumber - right.lineNumber;
    })[0];
}
