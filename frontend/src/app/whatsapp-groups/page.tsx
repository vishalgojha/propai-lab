import { redirect } from "next/navigation";

export default function WhatsAppGroupsPage() {
  redirect("/whatsapp?tab=groups");
}
