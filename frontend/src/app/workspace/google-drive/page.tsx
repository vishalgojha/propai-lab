import { redirect } from "next/navigation";

export default function LegacyGoogleDrivePage() {
  redirect("/account?tab=instinct");
}
