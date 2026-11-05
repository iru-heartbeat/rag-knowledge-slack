import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 管理画面・検索画面・ログイン画面へのリクエストのたびに、ログインの有効期限を延ばす（Cookie を更新する）。
 * ここは「更新」だけが仕事で、入ってよいかの判定はしない。判定は各画面・各操作が requireAdmin() で行う。
 * （middleware だけに判定を任せると、これを迂回された時に無防備になるため）
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    },
  );
  await supabase.auth.getUser();
  return response;
}

export const config = { matcher: ["/admin/:path*", "/search/:path*", "/login"] };
