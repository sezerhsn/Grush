// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRedemptionGateway {
    enum Status {
        None,
        Requested,
        Cancelled,
        Rejected,
        Fulfilled
    }

    struct RedemptionRequest {
        address requester;
        uint256 amount;
        uint64 createdAt;
        Status status;
        bytes32 destinationHash;
        bytes32 decisionRef;
        uint64 decidedAt;
        address decidedBy;
    }

    event RedemptionRequested(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed destinationHash,
        uint64 createdAt
    );

    event RedemptionCancelled(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        uint64 cancelledAt
    );

    event RedemptionRejected(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed reasonHash,
        address decidedBy,
        uint64 decidedAt
    );

    event RedemptionFulfilled(
        bytes32 indexed requestId,
        address indexed requester,
        uint256 amount,
        bytes32 indexed fulfillmentRef,
        address decidedBy,
        uint64 decidedAt
    );

    function requestRedemption(uint256 amount, bytes32 destinationHash) external returns (bytes32 requestId);

    function requestRedemptionWithPermit(
        uint256 amount,
        bytes32 destinationHash,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 requestId);

    function cancelRedemption(bytes32 requestId) external;

    function rejectRedemption(bytes32 requestId, bytes32 reasonHash) external;

    function fulfillRedemption(bytes32 requestId, bytes32 fulfillmentRef) external;

    function getRequest(bytes32 requestId) external view returns (RedemptionRequest memory);

    function statusOf(bytes32 requestId) external view returns (Status);

    function escrowBalance() external view returns (uint256);
}
