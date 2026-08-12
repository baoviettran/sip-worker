export class Headers {
  private readonly rows: Array<{ name: string; lower: string; value: string }> = [];
  append(name: string, value: string): void { this.rows.push({ name, lower: name.toLowerCase(), value }); }
  set(name: string, value: string): void { this.delete(name); this.append(name, value); }
  get(name: string): string | undefined { return this.rows.find((r) => r.lower === name.toLowerCase())?.value; }
  getAll(name: string): string[] { return this.rows.filter((r) => r.lower === name.toLowerCase()).map((r) => r.value); }
  has(name: string): boolean { return this.get(name) !== undefined; }
  delete(name: string): void {
    const lower = name.toLowerCase();
    for (let i = this.rows.length - 1; i >= 0; i -= 1) if (this.rows[i]?.lower === lower) this.rows.splice(i, 1);
  }
  entries(): ReadonlyArray<readonly [string, string]> { return this.rows.map((r) => [r.name, r.value] as const); }
  clone(): Headers { const out = new Headers(); for (const [n, v] of this.entries()) out.append(n, v); return out; }
}
