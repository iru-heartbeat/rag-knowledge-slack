// 検索の動作確認・類似度の下限（config.search.minSimilarity）の調整用。下限で捨てる前の生の類似度を表示する。
// 実行: npx tsx --conditions=react-server --env-file=.env.local scripts/try-search.ts <users.id> "質問1" "質問2" ...
import { embedQuery } from "../src/lib/ingest/embed";
import { getAdminClient } from "../src/lib/supabase";

async function main() {
  const [userId, ...questions] = process.argv.slice(2);
  if (!userId || questions.length === 0) throw new Error('使い方: try-search.ts <users.id> "質問" ...');

  const db = getAdminClient();
  for (const q of questions) {
    const { data, error } = await db.rpc("match_chunks", {
      query_embedding: await embedQuery(q),
      p_user_id: userId,
      match_count: 5,
    });
    if (error) throw new Error(error.message);
    console.log(`\n■ ${q}`);
    for (const r of data as Array<{ title: string; section_title: string | null; similarity: number }>) {
      console.log(`  ${r.similarity.toFixed(3)}  ${r.title}  ${r.section_title ?? ""}`);
    }
    if (data.length === 0) console.log("  （該当なし）");
  }
}

main().catch((e) => {
  console.error("失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
});
