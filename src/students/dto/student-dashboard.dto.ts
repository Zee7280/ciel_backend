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
    type: 'urgent' | 'warning' | 'info';
}

export interface StudentDashboardResponse {
    success: boolean;
    data: {
        stats: DashboardStats;
        activeProjects: ActiveProject[];
        deadlines: Deadline[];
    };
}
