import { useCallback, useEffect, useState } from "react";

const API_URL = "/api/hello/";

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <code className="stat-value">{value}</code>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}?t=${Date.now()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Django returned HTTP ${response.status}`);
      }
      setData(await response.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shortVersion = data?.version ? data.version.slice(0, 12) : "loading";

  return (
    <main className="page">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <section className="card">
        <header className="hero">
          <div className="badge">Floci &middot; Gitea Actions &middot; ECR &middot; EC2</div>
          <h1>
            Hello from <span>Django</span> + <span>React</span>
          </h1>
          <p className="subtitle">
            This page is served by Django and fetches live JSON from the same
            container. Every push to <code>main</code> rebuilds the image, pushes
            it to ECR, and redeploys this EC2 target over SSM.
          </p>
        </header>

        <div className="status-row">
          <span className={`dot ${error ? "dot-error" : loading ? "dot-wait" : ""}`} />
          <span>
            {error ? "Backend unreachable" : loading ? "Contacting Django..." : "Backend healthy"}
          </span>
          <button className="refresh" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>

        {error && (
          <div className="error">
            <strong>Could not load /api/hello/</strong>
            <p>{error}</p>
          </div>
        )}

        {data && (
          <>
            <p className="message">{data.message}</p>

            <div className="grid">
              <Stat label="Service" value={data.service} />
              <Stat label="Environment" value={data.environment} />
              <Stat label="Version" value={shortVersion} />
              <Stat label="Hostname" value={data.hostname} />
              <Stat label="Deployed at" value={data.deployed_at} />
              <Stat label="Server time" value={data.server_time} />
            </div>

            <div className="stack">
              {Object.entries(data.stack).map(([key, value]) => (
                <div className="pill" key={key}>
                  <span>{key}</span>
                  {value}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="footer">
        Django &middot; gunicorn &middot; WhiteNoise &middot; React &middot; Vite &middot;
        Docker &middot; Floci ECR &middot; SSM Run Command
      </footer>
    </main>
  );
}
