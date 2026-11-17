import { redirect } from "next/navigation";

// Retired broker module. Existing stored records and APIs are unchanged.
export default function RetiredBrokerModulePage() {
  redirect("/dashboard");
}
