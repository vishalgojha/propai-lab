import { redirect } from "next/navigation";

export default function ReviewCenterAlias() {
  redirect("/chat?tab=review");
}
