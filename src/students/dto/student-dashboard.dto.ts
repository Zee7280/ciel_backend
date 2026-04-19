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
}

export interface ContinueReportQuickAction {
    projectId: string;
    title: string;
    subtitle: string;
}

export interface DashboardQuickActions {
    continueReport: ContinueReportQuickAction | null;
}

export interface DashboardNotificationItem {
    id: string;
    title: string;
    detail: string;
    tone?: 'urgent' | 'warning' | 'neutral';
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
