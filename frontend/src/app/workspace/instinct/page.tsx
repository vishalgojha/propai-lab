import { redirect } from "next/navigation";

export default function InstinctWorkspaceRedirect() {
  redirect("/account?tab=mcp");
}
