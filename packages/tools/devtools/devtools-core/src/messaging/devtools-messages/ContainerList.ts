/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ContainerMetadata } from "../../ContainerMetadata";
import { IDevtoolsMessage } from "../Messages";

/**
 * Encapsulates types and logic related to {@link ContainerList.Message}.
 *
 * @internal
 */
export namespace ContainerList {
	/**
	 * {@link ContainerList.Message} {@link IDevtoolsMessage."type"}.
	 *
	 * @internal
	 */
	export const MessageType = "CONTAINER_LIST";

	/**
	 * Message data format used by {@link ContainerList.Message}.
	 *
	 * @internal
	 */
	export interface MessageData {
		/**
		 * Metadata list of Containers with active Client Debugger sessions registered.
		 */
		containers: ContainerMetadata[];
	}

	/**
	 * Outbound message containing the list of Container-level devtools instances tracked by the root Devtools.
	 *
	 * Includes the new list of active Container IDs associated with active Container Devtools instances.
	 *
	 * @internal
	 */
	export interface Message extends IDevtoolsMessage<MessageData> {
		/**
		 * {@inheritDoc IDevtoolsMessage."type"}
		 */
		type: typeof MessageType;
	}

	/**
	 * Creates a {@link ContainerList.Message} from the provided {@link ContainerList.MessageData}.
	 *
	 * @internal
	 */
	export function createMessage(data: MessageData): Message {
		return {
			data,
			type: MessageType,
		};
	}
}