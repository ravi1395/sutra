/** One in-flight/resolved autocomplete scan, owned by its workspace root. */
export class ComposerFileCache {
  private entry: { root: string; files: Promise<string[]> } | null = null;

  constructor(private readonly load: (root: string) => Promise<string[]>) {}

  get(root: string): Promise<string[]> {
    if (this.entry?.root === root) return this.entry.files;
    const files = this.load(root);
    this.entry = { root, files };
    return files;
  }

  clear(): void {
    this.entry = null;
  }
}
