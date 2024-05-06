import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ContextState } from "./globalContextsProvider";
import { getModDownloadUrl } from "../gamebananaApi/useModDownloadUrl";
import type { GamebananaModId } from "~/components/mods/types";
import axios from "axios";




export type ModDownloadUrlState = Record<GamebananaModId, string>;




const modDownloadUrlContext = createContext<ContextState<ModDownloadUrlState> | undefined>(undefined);


export const ModDownloadUrlsContextProvider = ({ children }: { children: React.ReactNode; }) => {
    const [modDownloadUrls, setModDownloadUrls] = useState<ModDownloadUrlState>({});


    const modDownloadUrlsState = useMemo(
        () => ({
            state: modDownloadUrls,
            update: setModDownloadUrls,
        }),
        [modDownloadUrls],
    );


    return (
        <modDownloadUrlContext.Provider value={modDownloadUrlsState}>
            {children}
        </modDownloadUrlContext.Provider>
    );
};




type useModDownloadUrlProps = {
    gamebananaModId: number,
};


export const useModDownloadUrl = (
    {
        gamebananaModId,
    }: useModDownloadUrlProps,
): string => {
    const contextOrUndefined = useContext(modDownloadUrlContext);

    const cachedDownloadUrl = contextOrUndefined?.state[gamebananaModId];

    const [downloadUrl, setDownloadUrl] = useState<string>(cachedDownloadUrl ?? "");


    useEffect(() => {
        if (cachedDownloadUrl) return;

        if (contextOrUndefined === undefined) throw "useModDownloadUrl must be used within a ModDownloadUrlsContextProvider";


        const source = axios.CancelToken.source();


        const fetchDownloadUrl = async () => {
            const fetchedDownloadUrl = await getModDownloadUrl(gamebananaModId, source);

            if (fetchedDownloadUrl === undefined) return;
            

            setDownloadUrl(fetchedDownloadUrl);

            contextOrUndefined.update(
                (previousState) => ({
                    ...previousState,
                    [gamebananaModId]: fetchedDownloadUrl,
                })
            );
        };

        fetchDownloadUrl();


        return () => {
            source.cancel();
        };
    }, [gamebananaModId, contextOrUndefined, cachedDownloadUrl]);


    return downloadUrl;
};