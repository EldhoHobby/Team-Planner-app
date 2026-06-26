export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 640 }}>
      <h1>Team Planner</h1>
      <p>Phase 1 scaffold is running. Phase 2 adds the setup wizard and auth.</p>
      <p>
        Health check: <a href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
