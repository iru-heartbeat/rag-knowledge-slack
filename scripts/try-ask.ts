// 検索 → 回答生成を通しで試す動作確認用。回答までの所要時間（30秒目標）も表示する。
// 実行: npx tsx --conditions=react-server --env-file=.env.local scripts/try-ask.ts <users.id> "質問1" "質問2" ...
import { generateAnswer } from "../src/lib/rag/answer";
import { retrieveChunks } from "../src/lib/rag/retrieve";
import { getAdminClient } from "../src/lib/supabase";

async function main() {
  const [userId, ...questions] = process.argv.slice(2);
  if (!userId || questions.length === 0) throw new Error('使い方: try-ask.ts <users.id> "質問" ...');

  const db = getAdminClient();
  for (const q of questions) {
    const t0 = Date.now();
    const chunks = await retrieveChunks(db, { userId, question: q });
    const r = await generateAnswer(q, chunks);
    console.log(`\n■ ${q}  （根拠 ${chunks.length} 件 / ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    console.log(`[${r.status}]\n${r.answer}`);
    for (const s of r.sources) {
      console.log(`  出典: ${s.title} ${s.sectionTitle ?? ""} (${s.docDate ?? s.docYear ?? "日付なし"}) ${s.customer ?? ""}`);
    }
  }
}

main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});
