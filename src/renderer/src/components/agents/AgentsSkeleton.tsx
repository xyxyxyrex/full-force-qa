export default function AgentsSkeleton() {
  return <section className="agents-panel agents-skeleton" role="status" aria-label="Loading agent settings" aria-busy="true">
    <div className="agents-skeleton-line heading" aria-hidden="true" />
    <div className="agents-skeleton-line" aria-hidden="true" />
    <div className="agents-setup" aria-hidden="true">
      <div className="agents-provider-list">{Array.from({ length: 8 }, (_, i) => <div className="agents-skeleton-line provider" key={i} />)}</div>
      <div className="agents-config">{Array.from({ length: 5 }, (_, i) => <div className="agents-skeleton-line field" key={i} />)}</div>
    </div>
  </section>
}
