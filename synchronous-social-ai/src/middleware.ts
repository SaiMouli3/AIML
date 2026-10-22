import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/signup", "/invite", "/api", "/_next", "/favicon"];

/** Cheap edge check: unauthenticated visitors to app pages go to /login. Real auth happens server-side. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const has = req.cookies.has("ssa_session") || req.cookies.has("__Host-ssa_session");
  if (!has && pathname !== "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
