export interface DashboardStats {
    activeCourses: number;
    impactPoints: number;
    projectsCompleted: number;
    hoursVolunteered: number;
}

export interface ActiveProject {
    id: string;
    title: string;
    category: string;
    assignedAt: string; // ISO Date
    status: string;
    progress: number; // 0-100
    /** Canonical report lifecycle for this project when a student_reports row exists (additive for clients). */
    report_status?: string | null;
}

export interface Deadline {
    id: string;
    title: string;
    date: string; // ISO Date
    /** urgent → red; warning → amber; any other string → default styling */
    type: string;
}

export interface DashboardOverviewSample {
    id: string;
    title: string;
    hint?: string;
}

export interface DashboardOverview {
    activeProjectsCount: number;
    pendingApprovalsCount: number;
    reportsUnderReviewCount: number;
    totalVerifiedHours: number;
    completedCount: number;
    pendingApprovalsSample: DashboardOverviewSample[];
    reportsUnderReviewSample: DashboardOverviewSample[];
    hoursActivityBars: number[];
    completedActivityBars: number[];
    completedSample?: { id: string; title: string };
    impactHistoryBadgeCount?: number;
    /** Reports where the student still owes fee / must submit payment proof (`partner_verified`, legacy `payment_pending`). */
    pendingPaymentsCount?: number;
    /** Reports with proof submitted and awaiting staff (`payment_under_review`). */
    paymentsUnderReviewCount?: number;
    pendingPaymentsSample?: DashboardOverviewSample[];
}

export interface ContinueReportQuickAction {
    projectId: string;
    title: string;
    subtitle: string;
}

export interface ViewPaymentQuickAction {
    projectId: string;
    title: string;
    subtitle?: string;
}

export interface ViewReportResultsQuickAction {
    projectId: string;
    title: string;
}

export interface DashboardQuickActions {
    continueReport: ContinueReportQuickAction | null;
    /** Deeplink to student payment flow (first project that needs fee / slip). */
    viewPayment?: ViewPaymentQuickAction | null;
    /** Distinct from payment: finalized report / outcome viewing. */
    viewReportResults?: ViewReportResultsQuickAction | null;
}

export interface DashboardNotificationItem {
    id: string;
    title: string;
    detail: string;
    tone?: 'urgent' | 'warning' | 'neutral';
    /** Lets the UI style tiles (e.g. payment vs generic review) without parsing copy. */
    category?: 'payment' | 'report' | 'approval' | 'deadline' | string;
}

export interface DashboardNotificationsPreview {
    active: DashboardNotificationItem[];
    pending: DashboardNotificationItem[];
    underReview: DashboardNotificationItem[];
}

export interface StudentDashboardResponse {
    success: boolean;
    data: {
        stats: DashboardStats;
        activeProjects: ActiveProject[];
        deadlines: Deadline[];
        overview?: DashboardOverview;
        quickActions?: DashboardQuickActions;
        notificationsPreview?: DashboardNotificationsPreview;
    };
}
