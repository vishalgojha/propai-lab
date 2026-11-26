import { notFound } from "next/navigation";
import FixtureClient from "./FixtureClient";

// Isolated render fixture for the dashboard action grid. Production serves
// 404; the route exists so the real ActionGrid component can be rendered and
// exercised without loading the full dashboard page.
export default function ActionGridFixture() {
  if (!process.env.ENABLE_DEV_FIXTURES) notFound();
  return <FixtureClient />;
}
