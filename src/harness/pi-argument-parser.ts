export function splitCommandArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}
