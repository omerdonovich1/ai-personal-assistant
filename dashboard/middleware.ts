import { NextRequest, NextResponse } from "next/server";

// Single-user gate: ?key=<DASHBOARD_SECRET> once → cookie → in.
// No secret configured → open (local dev).
export function middleware(req: NextRequest) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) return NextResponse.next();

  const url = req.nextUrl;
  const keyParam = url.searchParams.get("key");
  if (keyParam === secret) {
    url.searchParams.delete("key");
    const res = NextResponse.redirect(url);
    res.cookies.set("dash_key", secret, { httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    return res;
  }

  if (req.cookies.get("dash_key")?.value === secret) return NextResponse.next();

  return new NextResponse("401 — append ?key=<secret> to the URL once", { status: 401 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
