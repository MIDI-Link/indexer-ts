import express, { Express } from "express";
import dotenv from "dotenv";
import {
  BigNumber,
  Contract,
  getDefaultProvider,
  constants,
  ethers,
} from "ethers";
import { midiAbi } from "./abis/midi.abi";
import fetch from "node-fetch";
import { MIDIMetadata } from "./types/midi.types";
import { createDB } from "./supabase";
import { DB, init } from "./db";

dotenv.config();

const app: Express = express();
const port = process.env.PORT;
const midiAddress = process.env.MIDI_ADDRESS;
const providerEndpoint = process.env.PROVIDER_ENDPOINT;
const timeout = process.env.TIMEOUT ? +process.env.TIMEOUT : 300000; // defaults to 5 minutes
const validityCheckTimeout = process.env.VALIDITY_CHECK_TIMEOUT
  ? +process.env.VALIDITY_CHECK_TIMEOUT
  : 86400000;

const fetchMetadata = async (id: number, midiInstance: Contract) => {
  let uri = await midiInstance.uri(id);
  uri = uri.replace("ipfs://", "https://nftstorage.link/ipfs/");
  const res = await fetch(uri);
  if (!res.ok) {
    console.error("error fetching ", uri);
    return;
  }
  const metadata = (await res.json()) as MIDIMetadata;
  console.log("metadata is: ", metadata);
  return metadata;
};

const indexById = async ({
  db,
  id,
  operator,
  midiInstance,
}: {
  db: DB;
  id: number;
  operator: string;
  midiInstance: Contract;
}): Promise<{ error: string | undefined }> => {
  const metadata = await fetchMetadata(id, midiInstance);

  if (!metadata) {
    return { error: `failed fetching metadata` };
  }

  /**
   * Check if metadata has device in properties
   */
  if (metadata.properties.device) {
    let device = await db.devices.fetchByName({
      deviceName: metadata.properties.device,
    });

    /**
     * No device found in DB
     * Create a new one
     */
    if (!device) {
      const createdDevice = await db.devices.create({
        name: metadata.properties.device,
        manufacturer: metadata.properties.manufacturer ?? "",
      });

      /**
       * Creating the device failed
       */
      if (!createdDevice) {
        console.error("creating device failed");
        return {
          error: `creating device failed failed for ${metadata.properties.manufacturer}: ${metadata.properties.device}`,
        };
      }

      /**
       * otherwise we assign device
       */
      device = createdDevice;
    }

    const { error } = await db.midi.create({
      id,
      metadata,
      device: device.id,
      createdBy: operator,
    });

    if (error) {
      console.error("error updating midi metadata: ", error);
      return {
        error: `failed creating midi: ${error.details} ${error.message}`,
      };
    }

    return { error: undefined };
  } else {
    return { error: "no metadata.properties.device property" };
  }
};

const fetchOriginalMinter = async (id: number, midiInstance: Contract) => {
  ethers.constants.AddressZero;

  /**
   * fetch all TransferSingle where the from address was 0x0
   * (meaning it was newly minted)
   */
  const transferFromSingleEvents = await midiInstance.queryFilter(
    midiInstance.filters.TransferSingle(
      null,
      ethers.constants.AddressZero,
      null,
      null,
      null
    ),
    7853362
  );

  /**
   * find an event that matches the id we're searching for
   */
  const targetEvent = transferFromSingleEvents.find(
    (event) => event.args?.id.toNumber() === id
  );

  if (!targetEvent) {
    console.log("target event found!!!");
    return;
  }

  return targetEvent.args?.operator;
};

/**
 * this is run periodically to check that the DB matches what is on chain
 */
const sync = async ({
  db,
  midiInstance,
}: {
  db: DB;
  midiInstance: Contract;
}) => {
  const currentID = (await midiInstance.currentTokenId()) as BigNumber;
  const { data } = await db.midi.fetch();
  const queue = await db.queue.fetch(1000);
  const queueIDs = queue.map((row) => row.id);

  /**
   * discrepency exists
   */
  if (currentID.toNumber() !== data.length) {
    /**
     * build an array of 1 to currentID.toNumber()
     * representing the onchain token ids
     */
    const tokenIDs = Array.from(
      { length: currentID.toNumber() },
      (_, i) => i + 1
    );

    const dbRowIDs = data.map((row) => row.id);

    /**
     * filter for ids that do not exist in the DB
     */
    const diff = tokenIDs.filter((id) => !dbRowIDs.includes(id));

    /**
     * if the id already exists in the queue, we can ignore it
     * it has either failed too many times already
     * or will be picked up by indexer
     */
    const unqueueDiff = diff.filter((id) => !queueIDs.includes(id));

    /**
     * loop the difference
     */
    for (const id of unqueueDiff) {
      /**
       * fetch the operator
       */
      const operator = await fetchOriginalMinter(id, midiInstance);
      if (!operator) {
        console.error(`failed fetching operator for ${id}`);
        return;
      }

      indexById({ db, id, midiInstance, operator });
    }
  }
};

app.listen(port, async () => {
  if (!midiAddress) {
    throw new Error("process.env.MIDI_ADDRESS not set");
  }

  if (!providerEndpoint) {
    throw new Error("process.env.PROVIDER_ENDPOINT not set");
  }

  const supabase = await createDB();

  const midiInstance = new Contract(
    midiAddress,
    midiAbi,
    getDefaultProvider(providerEndpoint)
  );

  const db = init(supabase);

  midiInstance.on(
    "TransferSingle",
    async (operator: string, from: string, to: string, id: BigNumber) => {
      console.log("operator: ", operator);
      console.log("from: ", from);
      console.log("to: ", to);
      console.log("id: ", id);

      /**
       * newly minted
       */
      if (from === constants.AddressZero) {
        const { error } = await indexById({
          db,
          id: id.toNumber(),
          operator,
          midiInstance,
        });

        /**
         * if failed, create new queue row
         */
        if (error) {
          db.queue.create(id, error, operator);
        }
      }
    }
  );

  /**
   * Process queue
   */
  setInterval(async () => {
    /**
     * fetch queue
     */
    const queue = await db.queue.fetch(10);

    /**
     * loop
     */
    for (const row of queue) {
      const { error } = await indexById({
        db,
        id: row.id,
        midiInstance,
        operator: row.operator,
      });

      /**
       * if failed, updated queue row attempts and error message
       */
      if (error) {
        await db.queue.update({
          id: row.id,
          attempts: row.attempts + 1,
          error,
        });
      }
    }
  }, timeout);

  /**
   * to ensure consistency
   * we check the DB against the blockchain to make sure they're in sync
   */
  setInterval(() => {
    sync({ db, midiInstance });
  }, validityCheckTimeout);

  console.log(`??????[server]: Server is running at https://localhost:${port}`);
});
