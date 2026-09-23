import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/publish")({
  beforeLoad: () => {
    throw redirect({ to: "/sell" });
  },
});
