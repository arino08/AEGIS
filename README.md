# AEGIS Dashboard

A modern, real-time monitoring dashboard for the AEGIS API Gateway. Built with Next.js 14, TypeScript, and Tailwind CSS.

![AEGIS Dashboard](./docs/dashboard-preview.png)

## Features

- **Real-time Metrics** - Live updates via WebSocket connection
- **Interactive Charts** - Beautiful visualizations with Recharts
- **Responsive Design** - Works seamlessly on desktop and mobile
- **Dark Mode** - System preference detection + manual toggle
- **Time Range Selection** - View metrics for 1h, 6h, 24h, 7d, or 30d
- **Backend Health Monitoring** - Track the status of all backend services
- **Endpoint Analytics** - Top endpoints, latency percentiles, error rates

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Charts**: [Recharts](https://recharts.org/)
- **State Management**: [TanStack Query](https://tanstack.com/query)
- **Animations**: [Framer Motion](https://www.framer.com/motion/)
- **UI Components**: [Radix UI](https://www.radix-ui.com/)
- **Icons**: [Lucide React](https://lucide.dev/)

## Getting Started

### Prerequisites

- Node.js 18.0 or higher
- npm, yarn, or pnpm
- AEGIS Gateway running (default: http://localhost:8080)

### Installation

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy the example environment file and update values:

   ```bash
   cp env.local.example .env.local
   ```

   Edit `.env.local` with your configuration:

   ```env
   NEXT_PUBLIC_API_URL=http://localhost:8080
   NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws/metrics
   ```

3. **Start development server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3100](http://localhost:3100) in your browser.

### Production Build

```bash
# Build for production
npm run build

# Start production server
npm run start
```

## Project Structure

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── layout.tsx          # Root layout with providers
│   │   ├── page.tsx            # Main dashboard page
│   │   └── globals.css         # Global styles
│   │
│   ├── components/
│   │   ├── charts/             # Recharts-based chart components
│   │   │   └── index.tsx       # RequestRate, Latency, Error charts
│   │   ├── dashboard/          # Dashboard-specific components
│   │   │   └── overview.tsx    # Main overview component
│   │   ├── layout/             # Layout components
│   │   │   ├── sidebar.tsx     # Navigation sidebar
│   │   │   └── header.tsx      # Top header bar
│   │   └── ui/                 # Reusable UI components
│   │       ├── button.tsx      # Button variants
│   │       ├── card.tsx        # Card & MetricCard
│   │       └── select.tsx      # Select & TimeRangeSelect
│   │
│   ├── hooks/
│   │   └── useMetricsWebSocket.ts  # WebSocket hook for real-time data
│   │
│   ├── lib/
│   │   ├── api.ts              # API client for AEGIS Gateway
│   │   └── utils.ts            # Utility functions
│   │
│   └── types/
│       └── metrics.ts          # TypeScript type definitions
│
├── public/                     # Static assets
├── env.local.example           # Environment template
├── next.config.ts              # Next.js configuration
├── tailwind.config.ts          # Tailwind CSS configuration
├── tsconfig.json               # TypeScript configuration
└── package.json                # Dependencies and scripts
```

## API Integration

The dashboard connects to the AEGIS Gateway API endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/metrics/overview` | Dashboard overview stats |
| `GET /api/metrics/requests` | Request rate over time |
| `GET /api/metrics/latency` | Latency percentiles |
| `GET /api/metrics/errors` | Error rate breakdown |
| `GET /api/metrics/status` | Status code distribution |
| `GET /api/metrics/endpoints` | Per-endpoint metrics |
| `GET /api/metrics/endpoints/top` | Top endpoints by requests |
| `GET /_aegis/status` | Gateway status & backends |
| `WS /ws/metrics` | Real-time metrics stream |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | AEGIS Gateway API URL | `http://localhost:8080` |
| `NEXT_PUBLIC_WS_URL` | WebSocket URL | `ws://localhost:8080/ws/metrics` |
| `NEXT_PUBLIC_ENABLE_REALTIME` | Enable WebSocket updates | `true` |
| `NEXT_PUBLIC_DEBUG` | Enable debug logging | `false` |
| `NEXT_PUBLIC_DEFAULT_THEME` | Default theme | `system` |
| `NEXT_PUBLIC_DEFAULT_TIME_RANGE` | Default time range | `1h` |
| `NEXT_PUBLIC_REFRESH_INTERVAL` | Polling interval (ms) | `30000` |

## Development

### Available Scripts

```bash
# Start development server (port 3100)
npm run dev

# Build for production
npm run build

# Start production server
npm run start

# Run linter
npm run lint
```

### Adding New Pages

1. Create a new file in `src/app/` (e.g., `src/app/endpoints/page.tsx`)
2. Add navigation link in `src/components/layout/sidebar.tsx`
3. Implement the page component

### Adding New Charts

1. Add chart component in `src/components/charts/index.tsx`
2. Define data types in `src/types/metrics.ts`
3. Add API method in `src/lib/api.ts`

## Customization

### Theming

Edit `src/app/globals.css` to customize:

- Color palette (CSS variables)
- Fonts
- Shadows
- Border radius

### Chart Colors

Edit `src/components/charts/index.tsx`:

```typescript
export const chartColors = {
  primary: "#3b82f6",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  // ...
};
```

## Browser Support

- Chrome 90+
- Firefox 90+
- Safari 14+
- Edge 90+

## License

MIT License - see [LICENSE](../LICENSE) for details.

## Related

- [AEGIS Gateway](../) - Main gateway server
- [AEGIS API Documentation](../docs/api.md) - API reference