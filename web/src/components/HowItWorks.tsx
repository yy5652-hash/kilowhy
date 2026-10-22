export function HowItWorks() {
  return (
    <footer className="how-it-works">
      <h2>How it works</h2>
      <svg
        className="pipeline"
        viewBox="0 0 920 160"
        role="img"
        aria-label="Data flow from sources through Zetaris and Kilowhy to Nemotron"
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-muted)" />
          </marker>
        </defs>

        {/* Sources */}
        <rect x="8" y="20" width="150" height="120" rx="8" className="pipe-box" />
        <text x="83" y="42" textAnchor="middle" className="pipe-title">
          Sources
        </text>
        <text x="83" y="64" textAnchor="middle" className="pipe-line">
          Octopus Agile
        </text>
        <text x="83" y="82" textAnchor="middle" className="pipe-line">
          NESO · Elexon
        </text>
        <text x="83" y="100" textAnchor="middle" className="pipe-line">
          Open-Meteo
        </text>
        <text x="83" y="118" textAnchor="middle" className="pipe-line">
          sample meters
        </text>

        <line x1="158" y1="80" x2="198" y2="80" className="pipe-arrow" markerEnd="url(#arrow)" />

        {/* Zetaris */}
        <rect x="200" y="40" width="130" height="80" rx="8" className="pipe-box accent" />
        <text x="265" y="72" textAnchor="middle" className="pipe-title">
          Zetaris
        </text>
        <text x="265" y="94" textAnchor="middle" className="pipe-line">
          one SQL endpoint
        </text>

        <line x1="330" y1="80" x2="370" y2="80" className="pipe-arrow" markerEnd="url(#arrow)" />

        {/* Agent */}
        <rect x="372" y="16" width="220" height="128" rx="8" className="pipe-box" />
        <text x="482" y="40" textAnchor="middle" className="pipe-title">
          Kilowhy agent
        </text>
        <text x="482" y="62" textAnchor="middle" className="pipe-line">
          decompose · 11 hypotheses
        </text>
        <text x="482" y="80" textAnchor="middle" className="pipe-line">
          verifier
        </text>
        <text x="482" y="102" textAnchor="middle" className="pipe-line muted">
          Meterless engines:
        </text>
        <text x="482" y="120" textAnchor="middle" className="pipe-line muted">
          H-MEM · World Model · Markovian
        </text>

        <line x1="592" y1="80" x2="632" y2="80" className="pipe-arrow" markerEnd="url(#arrow)" />

        {/* Nightshift */}
        <rect x="634" y="40" width="140" height="80" rx="8" className="pipe-box accent" />
        <text x="704" y="72" textAnchor="middle" className="pipe-title">
          Meterless
        </text>
        <text x="704" y="94" textAnchor="middle" className="pipe-line">
          Nightshift
        </text>

        <line x1="774" y1="80" x2="814" y2="80" className="pipe-arrow" markerEnd="url(#arrow)" />

        {/* Nemotron */}
        <rect x="816" y="40" width="96" height="80" rx="8" className="pipe-box" />
        <text x="864" y="78" textAnchor="middle" className="pipe-title">
          Nemotron
        </text>
      </svg>
      <p className="built-with">
        Built with Cursor — see <code>docs/cursor-log</code>
      </p>
    </footer>
  );
}
