import express, { NextFunction, Response } from "express";
import axios from "axios";
import prismaNamespace from "@prisma/client";
import { prisma } from "../prismaClient";
import { validateMapPost, validateMapPatch, validateMapPut, validateModPost, validateModPatch, validatePublisherPatch } from "../jsonSchemas/maps-mods-publishers";
import { errorWithMessage, isErrorWithMessage, toErrorWithMessage, noRouteError, errorHandler, methodNotAllowed } from "../errorHandling";
import { expressRoute } from "../types/express";
import { mods_details, mods_details_type, publishers, difficulties, map_lengths } from ".prisma/client";
import {
    rawMod, rawMap, rawPublisher, createParentDifficultyForMod, createChildDifficultyForMod, jsonCreateMapWithMod, mapIdCreationObject,
    mapDetailsCreationObject, mapToTechCreationObject, defaultDifficultyForMod, submitterUser
} from "../types/internal";
import { formattedMod, formattedMap, formattedPublisher } from "../types/frontend";


const modsRouter = express.Router();
const mapsRouter = express.Router();
const publishersRouter = express.Router();
const submissionsRouter = express.Router();




interface difficultyNamesArrayElement {
    id?: number,
    name: string,
}




const canonicalDifficultyNameErrorMessage = "canonicalDifficulty does not match any default parent difficulty names";
const techNameErrorMessage = "A tech name in techAny did not match the names of any tech in the celestemods.com database";
const lengthErrorMessage = "length does not match the name of any map lengths in the celestemods.com database";
const invalidMapperUserIdErrorMessage = "No user found with ID = ";
const invalidMapDifficultyErrorMessage = `All maps in a non-Normal mod must be assigned a modDifficulty that matches the difficulties used by the mod (whether default or custom).
If the mod uses sub-difficulties, modDifficulty must be given in the form [difficulty, sub-difficulty].`;




//comment out for production
const submittingUser: submitterUser = {
    id: 5,
    displayName: "steve",
    discordID: "5",
    discordUsername: "steve",
    discordDiscrim: "5555",
    displayDiscord: false,
    timeCreated: 1,
    permissions: "",
    permissionsArray: [],
    accountStatus: "Active",
    timeDeletedOrBanned: null,
};




modsRouter.route("/")
    .get(async function (_req, res, next) {
        try {
            const rawMods = await prisma.mods_ids.findMany({
                where: { mods_details: { some: { NOT: { timeApproved: null } } } },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });


            const formattedMods = rawMods.map((rawmod) => {
                const formattedMod = formatMod(rawmod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .post(async function (req, res, next) {
        try {
            const modType: mods_details_type = req.body.type;
            const name: string = req.body.name;
            const publisherName: string | undefined = req.body.publisherName;
            const publisherID: number | undefined = req.body.publisherID;
            const publisherGamebananaID: number | undefined = req.body.publisherGamebananaID;
            const userID: number | undefined = req.body.userID;
            const contentWarning: boolean = req.body.contentWarning;
            const notes: string | undefined = req.body.notes;
            const shortDescription: string = req.body.shortDescription;
            const longDescription: string | undefined = req.body.longDescription;
            const gamebananaModID: number = req.body.gamebananaModID;
            const difficultyNames: (string | string[])[] | undefined = req.body.difficulties;
            const maps: jsonCreateMapWithMod[] = req.body.maps;
            const currentTime = Math.floor(new Date().getTime() / 1000);


            const valid = validateModPost({
                type: modType,
                name: name,
                publisherName: publisherName,
                publisherID: publisherID,
                publisherGamebananaID: publisherGamebananaID,
                userID: userID,
                contentWarning: contentWarning,
                notes: notes,
                shortDescription: shortDescription,
                longDescription: longDescription,
                gamebananaModID: gamebananaModID,
                difficultyNames: difficultyNames,
                maps: maps,
            });

            if (!valid) {
                res.status(400).json("Malformed request body");
                return;
            }


            const publisherConnectionObject = await getPublisherConnectionObject(res, userID, publisherGamebananaID, publisherID, publisherName);

            if (res.errorSent) return;

            if (!publisherConnectionObject || isErrorWithMessage(publisherConnectionObject)) {
                throw `publisherConnectionObject = "${publisherConnectionObject}"`;
            }


            let difficultyNamesArray: difficultyNamesArrayElement[] = [];
            let difficultiesCreationArray: createParentDifficultyForMod[] = [];
            let defaultDifficultyObjectsArray: defaultDifficultyForMod[] = [];
            let modHasSubDifficultiesBool = true;
            let modUsesCustomDifficultiesBool = true;

            if (difficultyNames) {
                const difficultyArrays = getDifficultyArrays(difficultyNames);

                if (isErrorWithMessage(difficultyArrays)) throw difficultyArrays;

                difficultyNamesArray = <difficultyNamesArrayElement[]>difficultyArrays[0];
                difficultiesCreationArray = <createParentDifficultyForMod[]>difficultyArrays[1];
                modHasSubDifficultiesBool = <boolean>difficultyArrays[2];

                modUsesCustomDifficultiesBool = true;
            }
            else {
                defaultDifficultyObjectsArray = await prisma.difficulties.findMany({
                    where: { parentModID: null },
                    include: { other_difficulties: true },
                });

                if (!defaultDifficultyObjectsArray.length) throw "there are no default difficulties";
            }


            const lengthObjectArray = await prisma.map_lengths.findMany();

            const mapsIDsCreationArray = await getMapIDsCreationArray(res, maps, currentTime, modType, lengthObjectArray,
                difficultiesCreationArray, defaultDifficultyObjectsArray, modUsesCustomDifficultiesBool, modHasSubDifficultiesBool);

            if (res.errorSent) return;


            const rawModAndStatus = await prisma.$transaction(async () => {
                const rawMatchingMod = await prisma.mods_ids.findFirst({
                    where: { mods_details: { some: { gamebananaModID: gamebananaModID } } },
                    include: {
                        difficulties: true,
                        mods_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: { publishers: true },
                        },
                        maps_ids: {
                            where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                            include: {
                                maps_details: {
                                    where: { NOT: { timeApproved: null } },
                                    orderBy: { revision: "desc" },
                                    take: 1,
                                    include: {
                                        map_lengths: true,
                                        difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                        difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                        users_maps_details_mapperUserIDTousers: true,
                                    },
                                },
                            },
                        },
                    },
                });

                if (rawMatchingMod) {
                    return [rawMatchingMod, 200];
                }


                const rawMod = await prisma.mods_ids.create({
                    data: {
                        difficulties: { create: difficultiesCreationArray },
                        mods_details: {
                            create: [{
                                type: modType,
                                name: name,
                                publishers: publisherConnectionObject,
                                contentWarning: contentWarning,
                                notes: notes,
                                shortDescription: shortDescription,
                                longDescription: longDescription,
                                gamebananaModID: gamebananaModID,
                                timeSubmitted: currentTime,
                                users_mods_details_submittedByTousers: { connect: { id: submittingUser.id } },
                            }],
                        },
                        maps_ids: { create: mapsIDsCreationArray},
                    },
                    include: {
                        difficulties: true,
                        mods_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: { publishers: true },
                        },
                        maps_ids: {
                            where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                            include: {
                                maps_details: {
                                    where: { NOT: { timeApproved: null } },
                                    orderBy: { revision: "desc" },
                                    take: 1,
                                    include: {
                                        map_lengths: true,
                                        difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                        difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                        users_maps_details_mapperUserIDTousers: true,
                                    },
                                },
                            },
                        },
                    },
                });

                return [rawMod, 201];
            });


            if (modUsesCustomDifficultiesBool && modType !== "Normal") {
                //next task = implement connecting modDifficulty
                //modDifficulty has already been checked by a helper function before the transaction, but could not be connected in the transaction
                throw "not implemented yet";
            }


            const rawMod = <rawMod>rawModAndStatus[0];
            const status = <number>rawModAndStatus[1];

            const formattedMod = formatMod(rawMod);

            if (isErrorWithMessage(formattedMod)) throw formattedMod;

            res.status(status).json(formattedMod);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.param("gbModID", async function (req, res, next) {
    try {
        const idRaw: unknown = req.params.gbModID;

        const id = Number(idRaw);

        if (isNaN(id)) {
            res.status(400).json("gamebananaModID is not a number");
            return;
        }

        const modFromID = await prisma.mods_ids.findFirst({
            where: {
                mods_details: {
                    some: {
                        NOT: { timeApproved: null },
                        gamebananaModID: id,
                    },
                },
            },
            include: {
                difficulties: true,
                mods_details: {
                    where: { NOT: { timeApproved: null } },
                    orderBy: { revision: "desc" },
                    take: 1,
                    include: { publishers: true },
                },
                maps_ids: {
                    where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                    include: {
                        maps_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: {
                                map_lengths: true,
                                difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                users_maps_details_mapperUserIDTousers: true,
                            },
                        },
                    },
                },
            },
        });

        if (!modFromID) {
            res.status(404).json("gamebananaModID does not exist");
            return;
        }

        req.mod = modFromID;
        req.id2 = id;
        next();
    }
    catch (error) {
        next(error);
    }
});


modsRouter.route("/gamebanana/:gbModID")
    .get(async function (req, res, next) {
        try {
            const rawMod = req.mod;

            if (!rawMod) throw "rawMod = null or undefined";

            const formattedMod = formatMod(rawMod);

            if (isErrorWithMessage(formattedMod)) throw formattedMod;

            res.json(formattedMod);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.route("/search")
    .get(async function (req, res, next) {
        try {
            const query = req.query.name;

            if (typeof (query) != "string") {
                res.sendStatus(400);
                return;
            }


            const rawMods = await prisma.mods_ids.findMany({
                where: {
                    mods_details: {
                        some: {
                            NOT: { timeApproved: null },
                            name: { startsWith: query },
                        },
                    },
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });


            const formattedMods: formattedMod[] = rawMods.map((rawMod) => {
                const formattedMod = formatMod(rawMod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })




modsRouter.route("/type")
    .get(async function (req, res, next) {
        try {
            const query = req.query.name;

            if (query !== "Normal" && query !== "Collab" && query !== "Contest" && query !== "Lobby") {
                res.sendStatus(400);
                return;
            }


            const rawMods = await prisma.mods_ids.findMany({
                where: {
                    mods_details: {
                        some: {
                            NOT: { timeApproved: null },
                            type: query,
                        },
                    },
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });


            const formattedMods: formattedMod[] = rawMods.map((rawMod) => {
                const formattedMod = formatMod(rawMod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.param("publisherID", async function (req, res, next) {
    try {
        const idRaw: unknown = req.params.publisherID;

        const id = Number(idRaw);

        if (isNaN(id)) {
            res.status(400).json("publisherID is not a number");
            return;
        }

        const modsFromID = await prisma.mods_ids.findMany({
            where: {
                mods_details: {
                    some: {
                        NOT: { timeApproved: null },
                        publisherID: id,
                    },
                },
            },
            include: {
                difficulties: true,
                mods_details: {
                    where: { NOT: { timeApproved: null } },
                    orderBy: { revision: "desc" },
                    take: 1,
                    include: { publishers: true },
                },
                maps_ids: {
                    where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                    include: {
                        maps_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: {
                                map_lengths: true,
                                difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                users_maps_details_mapperUserIDTousers: true,
                            },
                        },
                    },
                },
            },
        });

        if (!modsFromID || !modsFromID.length) {
            res.status(404).json("publisherID does not exist");
            return;
        }

        req.mods = modsFromID;
        req.id2 = id;
        next();
    }
    catch (error) {
        next(error);
    }
});


modsRouter.param("gbUserID", async function (req, res, next) {
    try {
        const idRaw: unknown = req.params.gbUserID;

        const id = Number(idRaw);

        if (isNaN(id)) {
            res.status(400).json("gamebananaUserID is not a number");
            return;
        }

        const modsFromID = await prisma.mods_ids.findMany({
            where: {
                mods_details: {
                    some: {
                        NOT: { timeApproved: null },
                        publishers: { gamebananaID: id },
                    },
                },
            },
            include: {
                difficulties: true,
                mods_details: {
                    where: { NOT: { timeApproved: null } },
                    orderBy: { revision: "desc" },
                    take: 1,
                    include: { publishers: true },
                },
                maps_ids: {
                    where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                    include: {
                        maps_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: {
                                map_lengths: true,
                                difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                users_maps_details_mapperUserIDTousers: true,
                            },
                        },
                    },
                },
            },
        });

        if (!modsFromID || !modsFromID.length) {
            res.status(404).json("gamebananaUserID does not exist");
            return;
        }

        req.mods = modsFromID;
        req.id2 = id;
        next();
    }
    catch (error) {
        next(error);
    }
});


modsRouter.route("/publisher/gamebanana/:gbUserID")
    .get(async function (req, res, next) {
        try {
            const rawMods = <rawMod[]>req.mods;     //can cast as rawMod[] because the router.param already checked that the array isnt empty


            const formattedMods = rawMods.map((rawmod) => {
                const formattedMod = formatMod(rawmod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


modsRouter.route("/publisher/:publisherID")
    .get(async function (req, res, next) {
        try {
            const rawMods = <rawMod[]>req.mods;     //can cast as rawMod[] because the router.param already checked that the array isnt empty


            const formattedMods = rawMods.map((rawmod) => {
                const formattedMod = formatMod(rawmod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.param("userID", async function (req, res, next) {
    try {
        await param_userID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


modsRouter.route("/user/:userID/publisher")
    .get(async function (req, res, next) {
        try {
            const userID = <number>req.id2;     //can cast as number because the router.param already checked that the id is valid


            const rawMods = await prisma.mods_ids.findMany({
                where: {
                    mods_details: {
                        some: {
                            NOT: { timeApproved: null },
                            publishers: { userID: userID },
                        },
                    },
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });


            const formattedMods = rawMods.map((rawmod) => {
                const formattedMod = formatMod(rawmod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


modsRouter.route("/user/:userID/submitter")
    .get(async function (req, res, next) {
        try {
            const userID = <number>req.id2;     //can cast as number because the router.param already checked that the id is valid


            const rawMods = await prisma.mods_ids.findMany({
                where: {
                    mods_details: {
                        some: {
                            NOT: { timeApproved: null },
                            submittedBy: userID,
                        },
                    },
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });


            const formattedMods = rawMods.map((rawmod) => {
                const formattedMod = formatMod(rawmod);
                if (isErrorWithMessage(formattedMod)) throw formattedMod;
                return formattedMod;
            });


            res.json(formattedMods);
        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.param("modID", async function (req, res, next) {
    try {
        await param_modID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


modsRouter.route("/:modID")
    .get(async function (req, res, next) {
        try {
            const rawMod = <rawMod>req.mod    //can cast as rawMod because the router.param already checked that the id is valid

            const formattedMod = formatMod(rawMod);

            if (isErrorWithMessage(formattedMod)) throw formattedMod;

            res.json(formattedMod);
        }
        catch (error) {
            next(error);
        }
    })
    .patch(async function (req, res, next) {
        try {
            const type: mods_details_type | undefined = req.body.type === null ? undefined : req.body.type;
            const name: string | undefined = req.body.name === null ? undefined : req.body.name;
            const publisherName: string | undefined = req.body.publisherName === null ? undefined : req.body.publisherName;
            const publisherID: number | undefined = req.body.publisherID === null ? undefined : req.body.publisherID;
            const publisherGamebananaID: number | undefined = req.body.publisherGamebananaID === null ? undefined : req.body.publisherGamebananaID;
            const userID: number | undefined = req.body.userID === null ? undefined : req.body.userID;
            const contentWarning: boolean | undefined = req.body.contentWarning === null ? undefined : req.body.contentWarning;
            const notes: string | undefined = req.body.notes === null ? undefined : req.body.notes;
            const shortDescription: string | undefined = req.body.shortDescription === null ? undefined : req.body.shortDescription;
            const longDescription: string | undefined = req.body.longDescription === null ? undefined : req.body.longDescription;
            const gamebananaModID: number | undefined = req.body.gamebananaModID === null ? undefined : req.body.gamebananaModID;
            const difficultyNames: string[] | undefined = req.body.difficultyNames === null ? undefined : req.body.difficultyNames;


            const valid = validateModPatch({
                type: type,
                name: name,
                publisherName: publisherName,
                publisherID: publisherID,
                publisherGamebananaID: publisherGamebananaID,
                userID: userID,
                contentWarning: contentWarning,
                notes: notes,
                shortDescription: shortDescription,
                longDescription: longDescription,
                gamebananaModID: gamebananaModID,
                difficultyNames: difficultyNames,
            });

            if (!valid) {
                res.status(400).json("Malformed request body");
                return;
            }


            const rawMatchingMod = await prisma.mods_ids.findFirst({
                where: {
                    NOT: { id: req.id },
                    mods_details: {
                        some: {
                            NOT: { timeApproved: null },    //should this be here? need to think about how this should work
                            gamebananaModID: gamebananaModID,
                        },
                    },
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });

            if (rawMatchingMod) {
                const formattedMatchingMod = formatMod(rawMatchingMod);

                if (isErrorWithMessage(formattedMatchingMod)) throw formattedMatchingMod;

                res.status(400).json(formattedMatchingMod);
            }


            const publisherConnectionObject = await getPublisherConnectionObject(res, userID, publisherGamebananaID, publisherID, publisherName);

            if (res.errorSent) return;

            if (!publisherConnectionObject || isErrorWithMessage(publisherConnectionObject)) {
                throw `publisherConnectionObject = "${publisherConnectionObject}"`;
            }


            let difficultyNamesArray: { name: string }[] = [];
            let difficultiesDataArray: createParentDifficultyForMod[] = [];
            let modHasSubDifficultiesBool = true;

            if (difficultyNames) {
                const difficultyArrays = getDifficultyArrays(difficultyNames);

                if (isErrorWithMessage(difficultyArrays)) throw difficultyArrays;

                difficultyNamesArray = <difficultyNamesArrayElement[]>difficultyArrays[0];
                difficultiesDataArray = <createParentDifficultyForMod[]>difficultyArrays[1];
                modHasSubDifficultiesBool = <boolean>difficultyArrays[2];
            }

            for (const parentDifficulty of difficultiesDataArray) {
                if (typeof (parentDifficulty) === "string") {

                }
            }

            // const test = await prisma.mods_ids.update({
            //     where: { id: req.id },
            //     data: {
            //         difficulties: {
            //             updateMany: {
            //                 where: {}
            //             }
            //         },
            //     },
            // });


            const rawMod = await prisma.mods_ids.update({
                where: { id: <number>req.id },  //can cast as number because the router.param already checked that the id was valid
                data: {
                    type: type,
                    name: name,
                    publishers: publisherConnectionObject,
                    contentWarning: contentWarning,
                    notes: notes,
                    shortDescription: shortDescription,
                    longDescription: longDescription,
                    gamebananaModID: gamebananaModID,
                },
                include: {
                    difficulties: true,
                    mods_details: {
                        where: { NOT: { timeApproved: null } },
                        orderBy: { revision: "desc" },
                        take: 1,
                        include: { publishers: true },
                    },
                    maps_ids: {
                        where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                        include: {
                            maps_details: {
                                where: { NOT: { timeApproved: null } },
                                orderBy: { revision: "desc" },
                                take: 1,
                                include: {
                                    map_lengths: true,
                                    difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                    difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                    users_maps_details_mapperUserIDTousers: true,
                                },
                            },
                        },
                    },
                },
            });
        }
        catch (error) {
            next(error);
        }
    })
    .delete(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .post(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




modsRouter.use(noRouteError);

modsRouter.use(errorHandler);




const getPublisherConnectionObject = async function (res: Response, userID?: number, publisherGamebananaID?: number,
    publisherID?: number, publisherName?: string): Promise<{} | void | errorWithMessage> {

    try {
        let publisherConnectionObject = {};


        if (userID) {
            const userFromID = await prisma.users.findUnique({
                where: { id: userID },
                include: { publishers: true },
            });

            if (!userFromID) {
                res.status(404).json("userID not found");
                res.errorSent = true;
                return;
            }

            if (userFromID.publishers.length < 1) {
                res.status(400).json("Specified user has no associated publishers.");
                res.errorSent = true;
                return;
            }

            if (userFromID.publishers.length > 1) {
                const publisherIDArray: number[] = []
                userFromID.publishers.map((publisher) => {
                    return publisher.id;
                });

                res.status(400).json(`Specified user has more than 1 associated publisher. Please specify publisherID instead.
                Publisher IDs associated with the specified user are: ${publisherIDArray}`);
                res.errorSent = true;
                return;
            }

            publisherConnectionObject = { connect: { id: userFromID.publishers[0].id } };
        }
        else if (publisherGamebananaID) {
            const publisherFromGbID = await prisma.publishers.findUnique({ where: { gamebananaID: publisherGamebananaID } });

            if (publisherFromGbID) {
                publisherConnectionObject = { connect: { id: publisherGamebananaID } };
            }
            else {
                const nameFromGamebanana = await getGamebananaUsernameById(publisherGamebananaID);

                if (isErrorWithMessage(nameFromGamebanana)) throw nameFromGamebanana;

                if (nameFromGamebanana == "false") {
                    res.status(404).json("Specified Member ID does not exist on GameBanana.");
                    res.errorSent = true;
                    return;
                }

                publisherConnectionObject = {
                    create: {
                        name: nameFromGamebanana,
                        gamebananaID: publisherGamebananaID,
                    },
                };
            }
        }
        else if (publisherID) {
            const publisherFromID = await prisma.publishers.findUnique({ where: { id: publisherID } });

            if (!publisherFromID) {
                res.status(404).json("publisherID not found.");
                res.errorSent = true;
                return;
            }

            publisherConnectionObject = { connect: { id: publisherID } };
        }
        else if (publisherName) {
            const publishersFromName = await prisma.publishers.findMany({ where: { name: publisherName } });

            if (publishersFromName.length > 1) {
                const publisherIDArray: number[] = []
                publishersFromName.map((publisher) => {
                    return publisher.id;
                });

                res.status(400).json(`More than one publisher has the specified name. Please specify publisherID instead.
                Publisher IDs with the specified name are: ${publisherIDArray}`);
                res.errorSent = true;
                return;
            }

            if (publishersFromName.length === 1) {
                publisherConnectionObject = { connect: { id: publishersFromName[0].id } };
            }
            else {
                const gamebananaID = await getGamebananaIdByUsername(publisherName);

                if (isErrorWithMessage(gamebananaID)) throw gamebananaID;

                if (gamebananaID === -1) {
                    res.status(404).json("Specified username does not exist on GameBanana.");
                    res.errorSent = true;
                    return;
                }

                publisherConnectionObject = {
                    create: {
                        name: publisherName,
                        gamebananaID: gamebananaID,
                    },
                };
            }
        }


        return publisherConnectionObject;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
};




const getDifficultyArrays = function (difficultyNames: (string | string[])[]) {
    try {
        let difficultyNamesArray: { name: string }[] = [];
        let difficultiesDataArray: createParentDifficultyForMod[] = [];
        let modHasSubDifficultiesBool = false;

        for (let parentDifficultyIndex = 0; parentDifficultyIndex < difficultyNames.length; parentDifficultyIndex++) {
            const parentDifficultyStringOrArray = difficultyNames[parentDifficultyIndex];

            if (typeof parentDifficultyStringOrArray === "string") {
                difficultiesDataArray.push({
                    name: parentDifficultyStringOrArray,
                    order: parentDifficultyIndex + 1,
                });
                difficultyNamesArray.push({ name: parentDifficultyStringOrArray });
                continue;
            }

            modHasSubDifficultiesBool = true;
            const childDifficultyArray: createChildDifficultyForMod[] = [];

            for (let childDifficultyIndex = 1; childDifficultyIndex < parentDifficultyStringOrArray.length; childDifficultyIndex++) {
                const childDifficultyName = parentDifficultyStringOrArray[childDifficultyIndex];

                childDifficultyArray.push({
                    name: childDifficultyName,
                    order: childDifficultyIndex,
                });

                difficultyNamesArray.push({ name: childDifficultyName });
            }

            difficultiesDataArray.push({
                name: parentDifficultyStringOrArray[0],
                order: parentDifficultyIndex + 1,
                other_difficulties: { create: childDifficultyArray },
            });

            difficultyNamesArray.push({ name: parentDifficultyStringOrArray[0] });
        }

        const returnArray: ({ name: string }[] | createParentDifficultyForMod[] | boolean)[] = [difficultyNamesArray, difficultiesDataArray, modHasSubDifficultiesBool];

        return returnArray;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
}




const formatMod = function (rawMod: rawMod) {
    try {
        if (rawMod.mods_details.length !== 1) {
            throw `more than 1 mod_details for mod ${rawMod.id} passed to formatMod`;
        }


        const id = rawMod.id;
        const revision = rawMod.mods_details[0].revision;
        const type = rawMod.mods_details[0].type;
        const name = rawMod.mods_details[0].name;
        const publisherID = rawMod.mods_details[0].publisherID;
        const publisherGamebananaID = rawMod.mods_details[0].publishers.gamebananaID === null ? undefined : rawMod.mods_details[0].publishers.gamebananaID;
        const contentWarning = rawMod.mods_details[0].contentWarning;
        const notes = rawMod.mods_details[0].notes === null ? undefined : rawMod.mods_details[0].notes;
        const shortDescription = rawMod.mods_details[0].shortDescription;
        const longDescription = rawMod.mods_details[0].longDescription === null ? undefined : rawMod.mods_details[0].longDescription;
        const gamebananaModID = rawMod.mods_details[0].gamebananaModID === null ? undefined : rawMod.mods_details[0].gamebananaModID;
        const rawMaps = rawMod.maps_ids;


        const formattedMaps = rawMaps.map((rawMap) => {
            const formattedMap = formatMaps(rawMap);

            if (isErrorWithMessage(formattedMap)) throw formattedMap;

            return formattedMap;
        });


        const formattedMod: formattedMod = {
            id: id,
            revision: revision,
            type: type,
            name: name,
            publisherID: publisherID,
            publisherGamebananaID: publisherGamebananaID,
            contentWarning: contentWarning,
            notes: notes,
            shortDescription: shortDescription,
            longDescription: longDescription,
            gamebananaModID: gamebananaModID,
            maps: formattedMaps,
        };

        if (rawMod.difficulties) {
            const formattedArray = getSortedDifficultyNames(rawMod.difficulties, id);

            formattedMod.difficulties = formattedArray;
        }


        return formattedMod;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
};




const getSortedDifficultyNames = function (difficulties: difficulties[], modID: number) {
    const parentDifficultyArray: difficulties[] = [];
    const subDifficultiesArray: difficulties[][] = [];

    for (const difficulty of difficulties) {     //iterate through all difficulties
        const parentDifficultyID = difficulty.parentDifficultyID;

        if (parentDifficultyID === null) {      //parent difficulties are added to parentDifficultyArray
            parentDifficultyArray.push(difficulty);
            continue;
        }


        let alreadyListed = false;      //sub-difficulties are added to an array of their siblings, which is an element of subDifficultiesArray

        for (const siblingArray of subDifficultiesArray) {
            if (siblingArray[0].parentDifficultyID === parentDifficultyID) {
                siblingArray.push(difficulty);
                alreadyListed = true;
                break;
            }
        }

        if (!alreadyListed) {
            subDifficultiesArray.push([difficulty]);
        }
    }


    const formattedArray: (string | string[])[] = [];   //the array that will be added to formattedMod

    for (let parentOrder = 1; parentOrder <= parentDifficultyArray.length; parentOrder++) {   //iterate through all parent difficulties
        let parentId = NaN;
        let parentName = "";
        let hasChildren = false;

        for (const difficulty of parentDifficultyArray) {   //find the parent difficulty that matches the current value of parentOrder
            if (difficulty.order === parentOrder) {
                parentId = difficulty.id;
                parentName = difficulty.name;
                break;
            }
        }

        for (const siblingArray of subDifficultiesArray) {      //check any of the sibling arrays contain children of the current parent difficulty
            if (siblingArray[0].parentDifficultyID === parentId) {
                const parentAndChildrenArray = [parentName];    //the parent does have children, so create an array with the parent's name as element 0

                for (let siblingOrder = 1; siblingOrder <= siblingArray.length; siblingOrder++) {   //iterate through the parent's children
                    for (const sibling of siblingArray) {       //find the sibling difficulty that matches the current value of siblingOrder
                        if (sibling.order === siblingOrder) {
                            parentAndChildrenArray.push(sibling.name);  //add the matching sibling's name to the array
                            break;
                        }
                    }
                }

                formattedArray.push(parentAndChildrenArray);    //push the finished array to formattedArray
                hasChildren = true;
                break;
            }
        }

        if (!hasChildren) {     //the parent does not have children, so add it to formattedArray as a string
            formattedArray.push(parentName);
        }
    }


    formattedArray.forEach((parentDifficulty) => {      //check that all orders are continuous
        if (parentDifficulty === "") {
            throw `Parent difficulty orders for mod ${modID} are not continuous`;
        }

        if (parentDifficulty instanceof Array) {
            parentDifficulty.forEach((childDifficulty) => {
                if (childDifficulty === "") {
                    throw `Child difficulty orders for parent difficulty ${parentDifficulty[0]} in mod ${modID} are not continuous`;
                }
            });
        }
    });


    return formattedArray;
}










mapsRouter.route("/")
    .get(async function (_req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.route("/search")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.route("/search/mapper")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.route("/search/tech")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.route("/search/tech/any")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.route("/search/tech/fc")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.param("lengthID", async function (req, res, next) {
    try {

    }
    catch (error) {
        next(error);
    }
});


mapsRouter.param("lengthOrder", async function (req, res, next) {
    try {

    }
    catch (error) {
        next(error);
    }
});


mapsRouter.route("/length/order/:lengthOrder")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


mapsRouter.route("/length/:lengthID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.param("userID", async function (req, res, next) {
    try {
        await param_userID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


mapsRouter.route("/user/:userID/mapper")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


mapsRouter.route("/user/:userID/submitter")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.param("mapID", async function (req, res, next) {
    try {
        await param_mapID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


mapsRouter.route("/:mapID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .patch(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .post(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .put(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .delete(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




mapsRouter.use(noRouteError);

mapsRouter.use(errorHandler);




const getMapIDsCreationArray = async function (res: Response, maps: jsonCreateMapWithMod[], currentTime: number, modType: mods_details_type, lengthObjectArray: map_lengths[],
    difficultiesCreationArray: createParentDifficultyForMod[], defaultDifficultyObjectsArray: defaultDifficultyForMod[],
    modUsesCustomDifficultiesBool: boolean, modHasSubDifficultiesBool: boolean) {

    try {
        const mapIDsCreationArray: mapIdCreationObject[] = await Promise.all(
            maps.map(
                async (mapObject: jsonCreateMapWithMod) => {
                    const mapIdCreationObject = await getMapIdCreationObject(mapObject, currentTime, modType, lengthObjectArray,
                        difficultiesCreationArray, defaultDifficultyObjectsArray, modUsesCustomDifficultiesBool, modHasSubDifficultiesBool);

                    return mapIdCreationObject;
                }
            )
        );

        return mapIDsCreationArray;
    }
    catch (error) {
        if (error === canonicalDifficultyNameErrorMessage) {
            res.status(404).json(canonicalDifficultyNameErrorMessage);
            res.errorSent = true;
            return;
        }
        if (error === techNameErrorMessage) {
            res.status(404).json(techNameErrorMessage);
            res.errorSent = true;
            return;
        }
        if (error === lengthErrorMessage) {
            res.status(404).json(lengthErrorMessage);
            res.errorSent = true;
            return;
        }
        if (typeof error === "string" && error.includes(invalidMapperUserIdErrorMessage)) {
            res.status(404).json(error);
            res.errorSent = true;
            return;
        }
        if (error === invalidMapDifficultyErrorMessage) {
            res.status(400).json(invalidMapDifficultyErrorMessage);
            res.errorSent = true;
            return;
        }

        throw error;
    }
}




const getMapIdCreationObject = async function (mapObject: jsonCreateMapWithMod, currentTime: number, modType: mods_details_type,
    lengthObjectArray: map_lengths[], customDifficultiesArray: createParentDifficultyForMod[], defaultDifficultyObjectsArray: defaultDifficultyForMod[],
    modUsesCustomDifficultiesBool: boolean, modHasSubDifficultiesBool: boolean) {

    const mapName = mapObject.name;
    const lengthName = mapObject.length;
    const mapDescription = mapObject.description;
    const mapNotes = mapObject.notes;
    const mapMinimumModVersion = mapObject.minimumModVersion;
    const mapRemovedFromModBool = mapObject.mapRemovedFromModBool;
    const techAny = mapObject.techAny;
    const techFC = mapObject.techFC;
    const canonicalDifficultyName = mapObject.canonicalDifficulty;
    const mapperUserID = mapObject.mapperUserID;
    const mapperNameString = mapObject.mapperNameString;
    const chapter = mapObject.chapter;
    const side = mapObject.side;
    const modDifficulty = mapObject.modDifficulty;
    const overallRank = mapObject.overallRank;


    const canonicalDifficultyID = await getCanonicalDifficultyID(canonicalDifficultyName, techAny);


    let lengthID = 0;

    for (const length of lengthObjectArray) {
        if (length.name === lengthName) {
            lengthID = length.id;
            break;
        }
    }

    if (lengthID === 0) throw lengthErrorMessage;


    const mapIdCreationObject: mapIdCreationObject = {
        map_details: {
            create: [{
                name: mapName,
                canonicalDifficulty: canonicalDifficultyID,
                map_lengths: { connect: { id: lengthID } },
                description: mapDescription,
                notes: mapNotes,
                minimumModVersion: mapMinimumModVersion,
                mapRemovedFromModBool: mapRemovedFromModBool,
                timeSubmitted: currentTime,
                users_maps_details_submittedByTousers: { connect: { id: submittingUser.id } },
            }],
        },
    };


    const privilegedUserBool = privilegedUser(submittingUser);

    if (isErrorWithMessage(privilegedUserBool)) throw privilegedUserBool;

    if (privilegedUserBool) {
        mapIdCreationObject.map_details.create[0].timeApproved = currentTime;
        mapIdCreationObject.map_details.create[0].users_maps_details_approvedByTousers = { connect: { id: submittingUser.id } };
    }


    if (mapperUserID) {
        const userFromID = await prisma.users.findUnique({ where: { id: mapperUserID } });

        if (!userFromID) throw invalidMapperUserIdErrorMessage + `${mapperUserID}`;

        mapIdCreationObject.map_details.create[0].users_maps_details_mapperUserIDTousers = { connect: { id: mapperUserID } };
    }
    else if (mapperNameString) {
        mapIdCreationObject.map_details.create[0].mapperNameString = mapperNameString;
    }


    if (modType === "Normal") {
        mapIdCreationObject.map_details.create[0].chapter = chapter;
        mapIdCreationObject.map_details.create[0].side = side;
    }
    else {
        handleNonNormalMods(mapIdCreationObject, modType, overallRank, modDifficulty, customDifficultiesArray,
            defaultDifficultyObjectsArray, modUsesCustomDifficultiesBool, modHasSubDifficultiesBool);
    }


    if (techAny || techFC) {
        const techCreationObjectArray: mapToTechCreationObject[] = [];


        if (techAny) {
            techAny.forEach((techName) => {
                const techCreationObject = {
                    maps_details_maps_detailsTomaps_to_tech_revision: 0,
                    tech_list: { connect: { name: techName } },
                    fullClearOnlyBool: false,
                };

                techCreationObjectArray.push(techCreationObject);
            });
        }


        if (techFC) {
            techFC.forEach((techName) => {
                const techCreationObject = {
                    maps_details_maps_detailsTomaps_to_tech_revision: 0,
                    tech_list: { connect: { name: techName } },
                    fullClearOnlyBool: true,
                };

                techCreationObjectArray.push(techCreationObject);
            });
        }


        mapIdCreationObject.map_details.create[0].maps_to_tech_maps_detailsTomaps_to_tech_mapID = { create: techCreationObjectArray };
    }


    return mapIdCreationObject;
};




const handleNonNormalMods = function (mapIdCreationObject: mapIdCreationObject, modType: mods_details_type, overallRank: number | undefined,
    modDifficulty: string | string[] | undefined, customDifficultiesArray: createParentDifficultyForMod[],
    defaultDifficultyObjectsArray: defaultDifficultyForMod[], modUsesCustomDifficultiesBool: boolean, modHasSubDifficultiesBool: boolean) {

    if (modType === "Contest") {
        mapIdCreationObject.map_details.create[0].overallRank = overallRank;
    }

    if (!modDifficulty) throw invalidMapDifficultyErrorMessage;

    let validModDifficultyBool = false;

    if (modUsesCustomDifficultiesBool) {
        if (!customDifficultiesArray.length) throw "customDifficultiesArray is empty";

        if (modHasSubDifficultiesBool) {
            if (!(modDifficulty instanceof Array)) throw invalidMapDifficultyErrorMessage;

            for (const difficulty of customDifficultiesArray) {
                if (!difficulty.other_difficulties) continue;

                if (difficulty.name === modDifficulty[0]) {
                    for (const childDifficulty of difficulty.other_difficulties.create) {
                        if (childDifficulty.name === modDifficulty[1]) {
                            validModDifficultyBool = true;
                            break;
                        }
                    }

                    break;
                }
            }
        }
        else {
            for (const difficulty of customDifficultiesArray) {
                if (typeof modDifficulty !== "string") throw invalidMapDifficultyErrorMessage;

                if (difficulty.name === modDifficulty) {
                    validModDifficultyBool = true;
                    break;
                }
            }
        }
    }
    else {
        if (!defaultDifficultyObjectsArray.length) throw "defaultDifficultyObjectsArray is empty";

        if (!(modDifficulty instanceof Array)) throw invalidMapDifficultyErrorMessage;

        for (const difficulty of defaultDifficultyObjectsArray) {
            if (!difficulty.other_difficulties || !difficulty.other_difficulties.length) continue;

            if (difficulty.name === modDifficulty[0]) {
                for (const childDifficulty of difficulty.other_difficulties) {
                    if (childDifficulty.name === modDifficulty[1]) {
                        validModDifficultyBool = true;
                        mapIdCreationObject.map_details.create[0].difficulties_difficultiesTomaps_details_modDifficultyID = { connect: { id: childDifficulty.id } };
                        break;
                    }
                }

                break;
            }
        }
    }
}




const getCanonicalDifficultyID = async function (canonicalDifficultyName: string | null | undefined, techAny: string[] | undefined) {
    const parentDefaultDifficultyObjectsArray = await prisma.difficulties.findMany({
        where: {
            parentModID: null,
            parentDifficultyID: null,
        },
    });


    if (canonicalDifficultyName) {
        for (const parentDifficulty of parentDefaultDifficultyObjectsArray) {
            if (parentDifficulty.name === canonicalDifficultyName) {
                return parentDifficulty.id;
            }
        }

        throw canonicalDifficultyNameErrorMessage;
    }
    else {
        if (!techAny) {
            let easiestDifficultyID = 0;
            let easiestDifficultyOrder = 99999;
            for (const parentDifficulty of parentDefaultDifficultyObjectsArray) {
                if (parentDifficulty.order === easiestDifficultyOrder) {
                    throw "Two default parent difficulties have the same order";
                }
                if (parentDifficulty.order < easiestDifficultyOrder) {
                    easiestDifficultyID = parentDifficulty.id;
                    easiestDifficultyOrder = parentDifficulty.order;
                }
            }

            if (easiestDifficultyID === 0) {
                throw "Unable to find easiest parent default difficulty";
            }

            return easiestDifficultyID;
        }

        const techObjectsWithDifficultyObjectsArray = await prisma.tech_list.findMany({ include: { difficulties: true } });

        let highestDifficultyID = 0;
        let highestDifficultyOrder = 0;

        for (const techName of techAny) {
            let validTechName = false;

            for (const techObject of techObjectsWithDifficultyObjectsArray) {
                if (techObject.name === techName) {
                    const difficultyOrder = techObject.difficulties.order;
                    validTechName = true;

                    if (difficultyOrder === highestDifficultyOrder) {
                        throw "Two default parent difficulties have the same order";
                    }

                    if (difficultyOrder > highestDifficultyOrder) {
                        highestDifficultyID = techObject.defaultDifficultyID;
                        highestDifficultyOrder = difficultyOrder;
                    }

                    break;
                }
            }

            if (!validTechName) {
                throw techNameErrorMessage;
            }
        }

        if (highestDifficultyID === 0) {
            throw "Unable to find highestDifficultyID";
        }

        return highestDifficultyID;
    }
};




const formatMaps = function (rawMap: rawMap): formattedMap | errorWithMessage {

};










publishersRouter.route("/")
    .get(async function (_req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




publishersRouter.route("/search")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




publishersRouter.param("userID", async function (req, res, next) {
    try {
        await param_userID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


publishersRouter.route("/user/:userID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




publishersRouter.param("publisherID", async function (req, res, next) {
    try {

    }
    catch (error) {
        next(error);
    }
});


publishersRouter.route("/:publisherID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .patch(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .delete(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




publishersRouter.use(noRouteError);

publishersRouter.use(errorHandler);










submissionsRouter.route("/")
    .get(async function (_req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




submissionsRouter.param("modID", async function (req, res, next) {
    try {
        await param_modID;
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


submissionsRouter.route("/mod/:modID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




submissionsRouter.param("mapID", async function (req, res, next) {
    try {
        await param_mapID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


submissionsRouter.route("/map/:mapID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




submissionsRouter.param("userID", async function (req, res, next) {
    try {
        await param_userID(req, res, next);
        if (!res.status) next();
    }
    catch (error) {
        next(error);
    }
});


submissionsRouter.route("/submitter/:userID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


submissionsRouter.route("/approver/:userID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




submissionsRouter.param("submissionID", async function (req, res, next) {
    try {

    }
    catch (error) {
        next(error);
    }
});


submissionsRouter.route("/:submissionID")
    .get(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .delete(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


submissionsRouter.route("/:submissionID/accept")
    .post(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);


submissionsRouter.route("/:submissionID/reject")
    .post(async function (req, res, next) {
        try {

        }
        catch (error) {
            next(error);
        }
    })
    .all(methodNotAllowed);




submissionsRouter.use(noRouteError);

submissionsRouter.use(errorHandler);










const param_userID = <expressRoute>async function (req, res, next) {
    try {
        const idRaw: unknown = req.params.userID;

        const id = Number(idRaw);

        if (isNaN(id)) {
            res.status(400).json("userID is not a number");
            return;
        }

        const exists = await prisma.users.findUnique({ where: { id: id } });

        if (!exists) {
            res.status(404).json("userID does not exist");
            return;
        }

        req.id2 = id;
        next();
    }
    catch (error) {
        next(error);
    }
}


const param_modID = <expressRoute>async function (req, res, next) {
    try {
        const idRaw: unknown = req.params.modID;

        const id = Number(idRaw);

        if (isNaN(id)) {
            res.status(400).json("modID is not a number");
            return;
        }

        const modFromID = await prisma.mods_ids.findUnique({
            where: { id: id },
            include: {
                difficulties: true,
                mods_details: {
                    where: { NOT: { timeApproved: null } },
                    orderBy: { revision: "desc" },
                    take: 1,
                    include: { publishers: true },
                },
                maps_ids: {
                    where: { maps_details: { some: { NOT: { timeApproved: null } } } },
                    include: {
                        maps_details: {
                            where: { NOT: { timeApproved: null } },
                            orderBy: { revision: "desc" },
                            take: 1,
                            include: {
                                map_lengths: true,
                                difficulties_difficultiesTomaps_details_canonicalDifficultyID: true,
                                difficulties_difficultiesTomaps_details_modDifficultyID: true,
                                users_maps_details_mapperUserIDTousers: true,
                            },
                        },
                    },
                },
            },
        });

        if (!modFromID) {
            res.status(404).json("modID does not exist");
            return;
        }

        req.mod = modFromID;
        req.id = id;
        next();
    }
    catch (error) {
        next(error);
    }
}


const param_mapID = <expressRoute>async function (req, res, next) {
    try {

    }
    catch (error) {
        next(error);
    }
}










const privilegedUser = function (user: submitterUser) {
    try {
        const permArray = user.permissionsArray;

        if (!permArray.length) return false;

        for (const perm of permArray) {
            if (perm === "Super_Admin" || perm === "Admin" || perm === "Map_Moderator") return true;
        }

        return false;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
}




const getGamebananaUsernameById = async function (gamebananaID: number) {
    try {
        const options = {
            url: `https://api.gamebanana.com/Core/Member/IdentifyById?userid=${gamebananaID}`
        };

        const axiosResponse = await axios(options);

        if (axiosResponse.status != 200) {
            const error = new Error("GameBanana api not responding as expected.");
            throw error;
        }

        const gamebananaName = String(axiosResponse.data[0]);

        return gamebananaName;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
}




const getGamebananaIdByUsername = async function (gamebananaUsername: string) {
    try {
        const options = {
            url: `https://api.gamebanana.com/Core/Member/Identify?username=${gamebananaUsername}`
        };

        const axiosResponse = await axios(options);

        if (axiosResponse.status != 200) {
            const error = new Error("GameBanana api not responding as expected.");
            throw error;
        }

        let gamebananaID = Number(axiosResponse.data[0]);

        if (isNaN(gamebananaID)) {
            gamebananaID = -1;
        }

        return gamebananaID;
    }
    catch (error) {
        return toErrorWithMessage(error);
    }
}


export { modsRouter, mapsRouter, publishersRouter, submissionsRouter as mSubmissionsRouter };