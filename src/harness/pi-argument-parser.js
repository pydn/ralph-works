export function splitCommandArgs(args) {
  return args.trim().split(/\s+/).filter(Boolean);
}
