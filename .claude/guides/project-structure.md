# Project Structure

Gitdog는 AI 기반 GitHub Assistant 플랫폼입니다.

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Backend**: Convex (serverless)
- **Payment**: Lemon Squeezy
- **Auth**: GitHub OAuth via @convex-dev/auth
- **i18n**: react-i18next (en, ko, ja)

## Directory Structure

```text
src/
├── components/          # Reusable UI components
│   ├── uis/            # Small UI primitives (LoadingIndicator, etc)
│   └── AdminLayout.tsx # Admin page layout
├── pages/
│   ├── admin/
│   │   ├── components/ # Admin-specific reusable components
│   │   ├── payments/   # Payment dashboard
│   │   └── workflows/  # AI workflow logs
│   ├── usage/          # User usage/subscription page
│   └── [feature]/      # Other feature pages
├── utils/
│   ├── signals/        # Preact signals for global state
│   └── cn.ts           # Tailwind class merge utility
└── i18n/
    └── locales/        # Translation files (en.json, ko.json, ja.json)

convex/
├── _generated/         # Auto-generated Convex types
├── admin/              # Admin-only functions
│   ├── query.ts        # Admin queries
│   ├── paymentQuery.ts # Payment stats queries
│   ├── paymentMutation.ts
│   └── testMutation.ts # Payment testing (dev only)
├── lemonSqueezy/       # Payment webhook handlers
├── subscriptions/      # User subscription management
├── paymentLogs/        # Payment event logging
└── [feature]/          # Other feature modules
```

## Key Conventions

### File Organization

- Screen-level components go directly in page folder, not nested `components/`
- Small, reusable components only in `components/` folders
- Admin pages: `admin/[feature]/index.tsx`

### Routing

- `/` - Workspace (repositories)
- `/usage` - User subscription & usage
- `/actions` - Action history
- `/admin/payments` - Payment dashboard (admin only)
- `/admin/workflows` - AI workflow logs (admin only)

### State Management

- Global state: `@preact/signals-react` (in `src/utils/signals/`)
- Local state: React `useState`
- Server state: Convex `useQuery`/`useMutation`
