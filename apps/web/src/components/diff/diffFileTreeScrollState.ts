const diffFileTreeScrollTopByKey = new Map<string, number>();

export function readDiffFileTreeScrollTop(key: string): number {
  return diffFileTreeScrollTopByKey.get(key) ?? 0;
}

export function writeDiffFileTreeScrollTop(key: string, scrollTop: number): void {
  diffFileTreeScrollTopByKey.set(key, scrollTop);
}
