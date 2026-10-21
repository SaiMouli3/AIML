import { redirect } from "next/navigation";
import { currentSession } from "@/server/http/page";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await currentSession();
  redirect(session ? "/overview" : "/login");
}
