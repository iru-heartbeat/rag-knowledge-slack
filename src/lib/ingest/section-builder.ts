import type { Section } from "./chunk";

/**
 * 「見出し」と「段落」を順に流し込むと Section[] を組み立てる。
 * 見出しの階層は「親 > 子」の形でタイトルにする（検索・出典表示で文脈になる）。
 * Word / PDF パーサーで共通利用する。
 */
export class SectionBuilder {
  private sections: Section[] = [];
  private stack: { level: number; text: string }[] = [];
  private title: string | null = null;
  private paragraphs: string[] = [];

  heading(level: number, text: string): void {
    if (!text) return;
    this.flush();
    while (this.stack.length && this.stack[this.stack.length - 1].level >= level) {
      this.stack.pop();
    }
    this.stack.push({ level, text });
    this.title = this.stack.map((s) => s.text).join(" > ");
  }

  paragraph(text: string): void {
    if (text) this.paragraphs.push(text);
  }

  build(): Section[] {
    this.flush();
    return this.sections;
  }

  private flush(): void {
    const text = this.paragraphs.join("\n\n").trim();
    if (text) this.sections.push({ title: this.title, text });
    this.paragraphs = [];
  }
}
