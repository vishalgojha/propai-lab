import { redirect } from "next/navigation";

export default function WhatsAppGroupsPage() {
  redirect("/inbox?view=groups");
}
