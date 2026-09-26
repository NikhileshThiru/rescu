/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/rescu.json`.
 */
export type Rescu = {
  "address": "GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5",
  "metadata": {
    "name": "rescu",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Rescu relief dollar: merchant registry, treasury and Token-2022 transfer hook"
  },
  "instructions": [
    {
      "name": "clawback",
      "discriminator": [
        111,
        92,
        142,
        79,
        33,
        234,
        82,
        27
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone can crank this once aid has expired; funds can only be burned, never redirected."
          ],
          "signer": true
        },
        {
          "name": "declaration",
          "writable": true
        },
        {
          "name": "mint",
          "writable": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "writable": true
        },
        {
          "name": "wallet",
          "docs": [
            "Only resident balances are clawed back; merchants keep what they earned."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "disburse",
      "discriminator": [
        68,
        250,
        205,
        89,
        217,
        142,
        13,
        44
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "declaration",
          "writable": true
        },
        {
          "name": "mint",
          "writable": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "amounts",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "enrollResident",
      "discriminator": [
        0,
        24,
        142,
        184,
        82,
        182,
        85,
        247
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "declaration"
        },
        {
          "name": "mint",
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "owner"
        },
        {
          "name": "tokenAccount",
          "docs": [
            "Must be the resident's associated token account: Token-2022 ATAs carry ImmutableOwner,",
            "so a resident can't sell the whole account by reassigning its owner."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "wallet",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "householdId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initDeclaration",
      "discriminator": [
        45,
        121,
        232,
        73,
        111,
        246,
        253,
        161
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "params.id"
              }
            ]
          }
        },
        {
          "name": "declaration",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  99,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "declarationParams"
            }
          }
        }
      ]
    },
    {
      "name": "registerMerchant",
      "discriminator": [
        238,
        245,
        77,
        132,
        161,
        88,
        216,
        248
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "declaration"
        },
        {
          "name": "owner"
        },
        {
          "name": "merchant",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  99,
                  104,
                  97,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "category",
          "type": "u8"
        },
        {
          "name": "h3Cell",
          "type": "u64"
        },
        {
          "name": "approved",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setClock",
      "discriminator": [
        59,
        152,
        168,
        11,
        171,
        63,
        136,
        143
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "declaration",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "timeScale",
          "type": "u32"
        },
        {
          "name": "simNow",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setMerchantStatus",
      "discriminator": [
        76,
        172,
        99,
        200,
        233,
        226,
        212,
        102
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Oracle (suspend / reinstate) or admin."
          ],
          "signer": true
        },
        {
          "name": "declaration"
        },
        {
          "name": "merchant",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "status",
          "type": {
            "defined": {
              "name": "merchantStatus"
            }
          }
        }
      ]
    },
    {
      "name": "setWalletFrozen",
      "discriminator": [
        179,
        237,
        132,
        131,
        211,
        144,
        5,
        151
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Oracle or admin."
          ],
          "signer": true
        },
        {
          "name": "declaration"
        },
        {
          "name": "mint",
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "frozen",
          "type": "bool"
        }
      ]
    },
    {
      "name": "transferHook",
      "docs": [
        "Token-2022 calls this on every relief-dollar transfer."
      ],
      "discriminator": [
        105,
        37,
        101,
        197,
        75,
        251,
        102,
        26
      ],
      "accounts": [
        {
          "name": "source"
        },
        {
          "name": "mint"
        },
        {
          "name": "destination"
        },
        {
          "name": "authority"
        },
        {
          "name": "extraAccountMetaList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "declaration"
        },
        {
          "name": "senderWallet",
          "writable": true
        },
        {
          "name": "merchant"
        },
        {
          "name": "receiverWallet"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateRules",
      "discriminator": [
        9,
        156,
        238,
        50,
        25,
        101,
        141,
        28
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "declaration"
          ]
        },
        {
          "name": "declaration",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "rulesParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "declaration",
      "discriminator": [
        201,
        133,
        199,
        39,
        115,
        245,
        184,
        148
      ]
    },
    {
      "name": "merchant",
      "discriminator": [
        71,
        235,
        30,
        40,
        231,
        21,
        32,
        64
      ]
    },
    {
      "name": "walletState",
      "discriminator": [
        126,
        186,
        0,
        158,
        92,
        223,
        167,
        68
      ]
    }
  ],
  "events": [
    {
      "name": "aidClawedBack",
      "discriminator": [
        136,
        12,
        132,
        194,
        124,
        179,
        104,
        80
      ]
    },
    {
      "name": "aidDisbursed",
      "discriminator": [
        152,
        21,
        18,
        184,
        174,
        48,
        45,
        143
      ]
    },
    {
      "name": "clockSet",
      "discriminator": [
        220,
        76,
        47,
        202,
        176,
        3,
        156,
        159
      ]
    },
    {
      "name": "declarationCreated",
      "discriminator": [
        83,
        90,
        94,
        186,
        68,
        118,
        252,
        127
      ]
    },
    {
      "name": "merchantRegistered",
      "discriminator": [
        202,
        61,
        140,
        95,
        139,
        239,
        17,
        83
      ]
    },
    {
      "name": "merchantStatusChanged",
      "discriminator": [
        17,
        58,
        131,
        180,
        84,
        58,
        244,
        14
      ]
    },
    {
      "name": "residentEnrolled",
      "discriminator": [
        48,
        140,
        239,
        198,
        203,
        25,
        81,
        88
      ]
    },
    {
      "name": "rulesUpdated",
      "discriminator": [
        100,
        24,
        7,
        239,
        176,
        206,
        193,
        94
      ]
    },
    {
      "name": "walletFrozen",
      "discriminator": [
        193,
        14,
        205,
        91,
        1,
        121,
        55,
        77
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notTransferring",
      "msg": "Hook was called outside a real token transfer"
    },
    {
      "code": 6001,
      "name": "unknownDeclaration",
      "msg": "This mint is not a Rescu relief dollar"
    },
    {
      "code": 6002,
      "name": "declarationInactive",
      "msg": "This disaster declaration is closed"
    },
    {
      "code": 6003,
      "name": "aidExpired",
      "msg": "This aid has expired"
    },
    {
      "code": 6004,
      "name": "notAResident",
      "msg": "Sender is not an enrolled resident"
    },
    {
      "code": 6005,
      "name": "notRegisteredMerchant",
      "msg": "Recipient is not a registered merchant"
    },
    {
      "code": 6006,
      "name": "resaleBlocked",
      "msg": "Aid can't be sent to another resident"
    },
    {
      "code": 6007,
      "name": "outOfZone",
      "msg": "Merchant is outside this disaster zone"
    },
    {
      "code": 6008,
      "name": "merchantNotApproved",
      "msg": "Merchant is not approved yet"
    },
    {
      "code": 6009,
      "name": "merchantSuspended",
      "msg": "Merchant is suspended"
    },
    {
      "code": 6010,
      "name": "overOrderCap",
      "msg": "Order is over the per-order cap"
    },
    {
      "code": 6011,
      "name": "overDailyCap",
      "msg": "Order would go over the 24-hour spending cap"
    },
    {
      "code": 6012,
      "name": "unauthorized",
      "msg": "Signer is not allowed to do this"
    },
    {
      "code": 6013,
      "name": "clawbackTooEarly",
      "msg": "Aid has not expired yet"
    },
    {
      "code": 6014,
      "name": "budgetExceeded",
      "msg": "Disbursement would exceed the declared budget"
    },
    {
      "code": 6015,
      "name": "invalidAccount",
      "msg": "Account does not belong to this declaration"
    },
    {
      "code": 6016,
      "name": "invalidArgument",
      "msg": "Invalid argument"
    },
    {
      "code": 6017,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "aidClawedBack",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "aidDisbursed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "declaration",
            "type": "pubkey"
          },
          {
            "name": "recipients",
            "type": "u32"
          },
          {
            "name": "total",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "clockSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "declaration",
            "type": "pubkey"
          },
          {
            "name": "timeScale",
            "type": "u32"
          },
          {
            "name": "simNow",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "declaration",
      "docs": [
        "One disaster declaration = one relief-dollar mint with its own rules and clock."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "docs": [
              "Government / treasury key: declares, enrolls, disburses, sets rules."
            ],
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "docs": [
              "Oracle key: can suspend merchants and freeze wallets, cannot move money."
            ],
            "type": "pubkey"
          },
          {
            "name": "perOrderCap",
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Aid stops being spendable at this sim timestamp; unspent aid can then be clawed back."
            ],
            "type": "i64"
          },
          {
            "name": "timeScale",
            "docs": [
              "Sim seconds per real second (1 = real time, 1440 = one sim day per real minute)."
            ],
            "type": "u32"
          },
          {
            "name": "anchorReal",
            "docs": [
              "Real unix timestamp at which the sim clock was last anchored."
            ],
            "type": "i64"
          },
          {
            "name": "anchorSim",
            "docs": [
              "Sim unix timestamp at `anchor_real`."
            ],
            "type": "i64"
          },
          {
            "name": "budget",
            "type": "u64"
          },
          {
            "name": "disbursed",
            "type": "u64"
          },
          {
            "name": "returned",
            "type": "u64"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "name",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "declarationCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "declaration",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "budget",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "declarationParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "oracle",
            "type": "pubkey"
          },
          {
            "name": "perOrderCap",
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "budget",
            "type": "u64"
          },
          {
            "name": "timeScale",
            "docs": [
              "Sim seconds per real second."
            ],
            "type": "u32"
          },
          {
            "name": "simStart",
            "docs": [
              "Sim timestamp at the moment of declaration."
            ],
            "type": "i64"
          },
          {
            "name": "aidDuration",
            "docs": [
              "How long aid stays spendable, in sim seconds (30 days = 2_592_000)."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "merchant",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Merchant wallet; payments go to its relief-dollar token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "zone",
            "docs": [
              "Mint of the declaration this merchant is approved to serve."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "merchantStatus"
              }
            }
          },
          {
            "name": "category",
            "docs": [
              "0 pharmacy, 1 grocery, 2 hardware, 3 general (display only)."
            ],
            "type": "u8"
          },
          {
            "name": "h3Cell",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "merchantRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "zone",
            "type": "pubkey"
          },
          {
            "name": "category",
            "type": "u8"
          },
          {
            "name": "h3Cell",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "merchantStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "approved"
          },
          {
            "name": "suspended"
          }
        ]
      }
    },
    {
      "name": "merchantStatusChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "residentEnrolled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "householdId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rulesParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "perOrderCap",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "dailyCap",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "expiresAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "active",
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "oracle",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "budget",
            "type": {
              "option": "u64"
            }
          }
        ]
      }
    },
    {
      "name": "rulesUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "declaration",
            "type": "pubkey"
          },
          {
            "name": "perOrderCap",
            "type": "u64"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "active",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "walletFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "frozen",
            "type": "bool"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "walletState",
      "docs": [
        "Per-resident spend state. Keyed by the resident's relief-dollar token account so it",
        "resolves the same way whether the resident or their agent (SPL delegate) signs."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "householdId",
            "type": "u64"
          },
          {
            "name": "lastHour",
            "docs": [
              "Sim hour (unix seconds / 3600) of the most recent spend."
            ],
            "type": "i64"
          },
          {
            "name": "hourlySpend",
            "docs": [
              "Spend per sim hour, ring-indexed by `hour % 24`."
            ],
            "type": {
              "array": [
                "u64",
                24
              ]
            }
          },
          {
            "name": "totalSpent",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "decimals",
      "docs": [
        "Relief dollars mirror USDC: 6 decimals, 1_000_000 base units = $1."
      ],
      "type": "u8",
      "value": "6"
    },
    {
      "name": "seedAuthority",
      "docs": [
        "Program-wide PDA that is mint, freeze and permanent-delegate authority for every relief mint."
      ],
      "type": "bytes",
      "value": "[97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "seedDeclaration",
      "type": "bytes",
      "value": "[100, 101, 99, 108]"
    },
    {
      "name": "seedExtraAccountMetas",
      "docs": [
        "Fixed by the transfer hook interface."
      ],
      "type": "bytes",
      "value": "[101, 120, 116, 114, 97, 45, 97, 99, 99, 111, 117, 110, 116, 45, 109, 101, 116, 97, 115]"
    },
    {
      "name": "seedMerchant",
      "type": "bytes",
      "value": "[109, 101, 114, 99, 104, 97, 110, 116]"
    },
    {
      "name": "seedMint",
      "type": "bytes",
      "value": "[109, 105, 110, 116]"
    },
    {
      "name": "seedWallet",
      "type": "bytes",
      "value": "[119, 97, 108, 108, 101, 116]"
    },
    {
      "name": "windowHours",
      "docs": [
        "Rolling spend window: 24 one-hour buckets."
      ],
      "type": "u8",
      "value": "24"
    }
  ]
};
