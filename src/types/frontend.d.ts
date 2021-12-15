import { difficulties } from ".prisma/client";

interface formattedUser {
  id: number;
  displayName: string;
  discordUsername?: string;
  discordDescrim?: string;
  displayDiscord?: boolean;
  timeCreated?: number;
  permissions?: string;
  accountStatus: string;
  timeDeletedOrBanned?: number;
  gamebananaIDs?: number[];
  goldenPlayerID?: number;
}

interface formattedTech {
  id: number;
  name: string;
  description?: string;
  difficulty: difficulties;
}

interface formattedMod {
  id: number;
  revision: number;
  type: string;
  name: string;
  publisherID: number;
  publisherGamebananaID?: number;
  contentWarning: boolean;
  notes?: string;
  shortDescription: string;
  longDescription?: string;
  gamebananaModID?: number;
  maps: formattedMap[];
  difficulties?: (string | string[])[];
}

interface formattedMap {

}

interface formattedPublisher {

}

export { formattedUser, formattedTech, formattedMod, formattedMap, formattedPublisher };