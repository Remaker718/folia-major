import { create } from 'zustand';
import type { HeartbeatRequestOptions, MediaId, OnlineProviderId } from '../types/onlineMusic';

// src/stores/useHeartbeatModeStore.ts
// A live recommendation session, deliberately not persisted or shared with Personal FM.

export interface HeartbeatSession extends HeartbeatRequestOptions {
    id: number;
    providerId: OnlineProviderId;
    userId: MediaId;
}

interface HeartbeatModeState {
    session: HeartbeatSession | null;
    loading: boolean;
    generation: number;
    begin: () => number;
    stop: () => void;
}

export const useHeartbeatModeStore = create<HeartbeatModeState>((set, get) => ({
    session: null,
    loading: false,
    generation: 0,
    begin: () => {
        const generation = get().generation + 1;
        set({ session: null, loading: true, generation });
        return generation;
    },
    stop: () => set(state => ({ session: null, loading: false, generation: state.generation + 1 })),
}));
