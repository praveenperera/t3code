/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { Layer } from "effect";

import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { makeCheckpointStoreShape } from "../makeCheckpointStoreShape.ts";

const makeCheckpointStore = makeCheckpointStoreShape();

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
