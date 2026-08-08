import { createContext, useContext } from 'react';

export const ReportsContext = createContext(null);

export function useReportsContext() {
    const ctx = useContext(ReportsContext);
    if (!ctx) throw new Error('useReportsContext must be used within ReportsContext');
    return ctx;
}
