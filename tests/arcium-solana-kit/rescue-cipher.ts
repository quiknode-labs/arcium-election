/**
 * Rescue Cipher implementation extracted from @arcium-hq/client v0.4.0
 * Source: node_modules/@arcium-hq/client/build/index.mjs (lines 1-1058)
 *
 * This file contains the Rescue cipher and related cryptographic primitives
 * needed for encrypting/decrypting data in Arcium confidential computing.
 *
 * Copied to eliminate dependency on @arcium-hq/client which depends on web3.js.
 * All code below this header is from @arcium-hq/client under GPL-3.0-only license.
 */

import { randomBytes } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { shake256 } from '@noble/hashes/sha3';
import { invert, pow2 } from '@noble/curves/abstract/modular';

/**
 * Scalar field prime modulus for Curve25519: 2^252 + 27742317777372353535851937790883648493
 */
const CURVE25519_SCALAR_FIELD_MODULUS = ed25519.CURVE.n;
/**
 * Generates a random value within the field bound by q.
 * @param q - The upper bound (exclusive) for the random value.
 * @returns A random bigint value between 0 and q-1.
 */
function generateRandomFieldElem(q) {
    const byteLength = (q.toString(2).length + 7) >> 3;
    let r;
    do {
        const randomBuffer = randomBytes(byteLength);
        r = BigInt(`0x${randomBuffer.toString('hex')}`);
    } while (r >= q);
    return r;
}
/**
 * Computes the positive modulo of a over m.
 * @param a - The dividend.
 * @param m - The modulus.
 * @returns The positive remainder of a mod m.
 */
function positiveModulo(a, m) {
    return ((a % m) + m) % m;
}
/**
 * Serializes a bigint to a little-endian Uint8Array of the specified length.
 * @param val - The bigint value to serialize.
 * @param lengthInBytes - The desired length of the output array.
 * @returns The serialized value as a Uint8Array.
 * @throws Error if the value is too large for the specified length.
 */
function serializeLE(val, lengthInBytes) {
    const result = new Uint8Array(lengthInBytes);
    let tempVal = val;
    for (let i = 0; i < lengthInBytes; i++) {
        result[i] = Number(tempVal & BigInt(255));
        tempVal >>= BigInt(8);
    }
    if (tempVal > BigInt(0)) {
        throw new Error(`Value ${val} is too large for the byte length ${lengthInBytes}`);
    }
    return result;
}
/**
 * Deserializes a little-endian Uint8Array to a bigint.
 * @param bytes - The Uint8Array to deserialize.
 * @returns The deserialized bigint value.
 */
function deserializeLE(bytes) {
    let result = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
        result |= BigInt(bytes[i]) << (BigInt(i) * BigInt(8));
    }
    return result;
}
// GENERAL
/**
 * Computes the SHA-256 hash of an array of Uint8Arrays.
 * @param byteArrays - The arrays to hash.
 * @returns The SHA-256 hash as a Buffer.
 */
function sha256(byteArrays) {
    const hash = createHash('sha256');
    byteArrays.forEach((byteArray) => {
        hash.update(byteArray);
    });
    return hash.digest();
}

/**
 * Converts a bigint to an array of bits (least significant to most significant, in 2's complement representation).
 * @param x - The bigint to convert.
 * @param binSize - The number of bits to use in the representation.
 * @returns An array of booleans representing the bits of x.
 */
function toBinLE(x, binSize) {
    const res = [];
    for (let i = 0; i < binSize; ++i) {
        res.push(ctSignBit(x, BigInt(i)));
    }
    return res;
}
/**
 * Converts an array of bits (least significant to most significant, in 2's complement representation) to a bigint.
 * @param xBin - The array of bits to convert.
 * @returns The bigint represented by the bit array.
 */
function fromBinLE(xBin) {
    let res = 0n;
    for (let i = 0; i < xBin.length - 1; ++i) {
        res |= BigInt(xBin[i]) << BigInt(i);
    }
    return res - (BigInt(xBin[xBin.length - 1]) << BigInt(xBin.length - 1));
}
/**
 * Binary adder between x and y (assumes xBin and yBin are of the same length and large enough to represent the sum).
 * @param xBin - The first operand as a bit array.
 * @param yBin - The second operand as a bit array.
 * @param carryIn - The initial carry-in value.
 * @param binSize - The number of bits to use in the operation.
 * @returns The sum as a bit array.
 */
function adder(xBin, yBin, carryIn, binSize) {
    const res = [];
    let carry = carryIn;
    for (let i = 0; i < binSize; ++i) {
        // res[i] = xBin[i] XOR yBin[i] XOR carry
        const yXorCarry = yBin[i] !== carry;
        res.push(xBin[i] !== yXorCarry);
        // newCarry = (xBin[i] AND yBin[i]) XOR (xBin[i] AND carry) XOR (yBin[i] AND carry)
        //          = (yBin[i] XOR carry) ? xBin[i] : yBin[i]
        const newCarry = yBin[i] !== (yXorCarry && (xBin[i] !== yBin[i]));
        carry = newCarry;
    }
    return res;
}
/**
 * Constant-time addition of two bigints, using 2's complement representation.
 * @param x - The first operand.
 * @param y - The second operand.
 * @param binSize - The number of bits to use in the operation.
 * @returns The sum as a bigint.
 */
function ctAdd(x, y, binSize) {
    const resBin = adder(toBinLE(x, binSize), toBinLE(y, binSize), false, binSize);
    return fromBinLE(resBin);
}
/**
 * Constant-time subtraction of two bigints, using 2's complement representation.
 * @param x - The first operand.
 * @param y - The second operand.
 * @param binSize - The number of bits to use in the operation.
 * @returns The difference as a bigint.
 */
function ctSub(x, y, binSize) {
    const yBin = toBinLE(y, binSize);
    const yBinNot = [];
    for (let i = 0; i < binSize; ++i) {
        yBinNot.push(yBin[i] === false);
    }
    const resBin = adder(toBinLE(x, binSize), yBinNot, true, binSize);
    return fromBinLE(resBin);
}
/**
 * Returns the sign bit of a bigint in constant time.
 * @param x - The bigint to check.
 * @param binSize - The bit position to check (typically the highest bit).
 * @returns True if the sign bit is set, false otherwise.
 */
function ctSignBit(x, binSize) {
    return ((x >> binSize) & 1n) === 1n;
}
/**
 * Constant-time less-than comparison for two bigints.
 * @param x - The first operand.
 * @param y - The second operand.
 * @param binSize - The number of bits to use in the operation.
 * @returns True if x < y, false otherwise.
 */
function ctLt(x, y, binSize) {
    return ctSignBit(ctSub(x, y, binSize), binSize);
}
/**
 * Constant-time select between two bigints based on a boolean condition.
 * @param b - The condition; if true, select x, otherwise select y.
 * @param x - The value to select if b is true.
 * @param y - The value to select if b is false.
 * @param binSize - The number of bits to use in the operation.
 * @returns The selected bigint.
 */
function ctSelect(b, x, y, binSize) {
    return ctAdd(y, BigInt(b) * (ctSub(x, y, binSize)), binSize);
}
/**
 * Checks if a bigint fits in the range -2^binSize <= x < 2^binSize.
 * Not constant-time for arbitrary x, but is constant-time for all inputs for which the function returns true.
 * If you assert your inputs satisfy verifyBinSize(x, binSize), you need not care about the non constant-timeness of this function.
 * @param x - The bigint to check.
 * @param binSize - The number of bits to use in the check.
 * @returns True if x fits in the range, false otherwise.
 */
function verifyBinSize(x, binSize) {
    const bin = (x >> binSize).toString(2);
    return bin === '0' || bin === '-1';
}

function isBrowser() {
    return (
    // eslint-disable-next-line no-prototype-builtins
    typeof window !== 'undefined' && !window.process?.hasOwnProperty('type'));
}
function optionalLog(log, ...args) {
    if (log) {
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}
function getBinSize(max) {
    // floor(log2(max)) + 1 to represent unsigned elements, a +1 for signed elements
    // and another +1 to account for the diff of two negative elements
    return BigInt(Math.floor(Math.log2(Number(max)))) + 3n;
}
/**
 * Compresses an array of bytes into 128-bit bigints.
 *
 * Takes an array of bytes whose length is a multiple of 16 and compresses each consecutive 16 bytes into a single 128-bit bigint.
 *
 * @param bytes - The input byte array. Its length must be a multiple of 16.
 * @returns An array of 128-bit bigints, each representing 16 bytes from the input.
 * @throws Error if the input length is not a multiple of 16.
 */
function compressUint128(bytes) {
    if (bytes.length % 16 !== 0) {
        throw Error(`bytes.length must be a multiple of 16 (found ${bytes.length})`);
    }
    const res = [];
    for (let n = 0; n < bytes.length / 16; ++n) {
        res.push(deserializeLE(bytes.slice(n * 16, (n + 1) * 16)));
    }
    return res;
}
/**
 * Decompresses an array of 128-bit bigints into a flattened byte array.
 *
 * Takes an array of 128-bit bigints and returns a Uint8Array containing the decompressed bytes (16 bytes per bigint).
 *
 * @param compressed - The input array of 128-bit bigints. Each bigint must be less than 2^128.
 * @returns A Uint8Array containing the decompressed bytes.
 * @throws Error if any bigint in the input is not less than 2^128.
 */
function decompressUint128(compressed) {
    compressed.forEach((c) => {
        if (c >= 1n << 128n) {
            throw Error(`input must be less than 2^128 (found ${c})`);
        }
    });
    const res = [];
    for (let n = 0; n < compressed.length; ++n) {
        res.push(...serializeLE(compressed[n], 16));
    }
    return new Uint8Array(res);
}

/**
 * Matrix class over FpField. Data is row-major.
 */
class Matrix {
    field;
    data;
    constructor(field, data) {
        this.field = field;
        const nrows = data.length;
        const ncols = data[0].length;
        for (let i = 1; i < nrows; ++i) {
            if (data[i].length !== ncols) {
                throw Error('All rows must have same number of columns.');
            }
        }
        this.data = data.map((row) => row.map((c) => field.create(c)));
    }
    /**
     * Matrix multiplication between `this` and `rhs`.
     */
    matMul(rhs) {
        const thisNrows = this.data.length;
        const thisNcols = this.data[0].length;
        const rhsNrows = rhs.data.length;
        const rhsNcols = rhs.data[0].length;
        if (thisNcols !== rhsNrows) {
            throw Error(`this.ncols must be equal to rhs.nrows (found ${thisNcols} and ${rhsNrows})`);
        }
        const data = [];
        for (let i = 0; i < thisNrows; ++i) {
            const row = [];
            for (let j = 0; j < rhsNcols; ++j) {
                let c = this.field.ZERO;
                for (let k = 0; k < thisNcols; ++k) {
                    c = this.field.add(c, this.field.mul(this.data[i][k], rhs.data[k][j]));
                }
                row.push(c);
            }
            data.push(row);
        }
        return new Matrix(this.field, data);
    }
    /**
     * Element-wise addition between `this` and `rhs`.
     */
    add(rhs, ct = false) {
        const thisNrows = this.data.length;
        const thisNcols = this.data[0].length;
        const rhsNrows = rhs.data.length;
        const rhsNcols = rhs.data[0].length;
        if (thisNrows !== rhsNrows) {
            throw Error(`this.nrows must be equal to rhs.nrows (found ${thisNrows} and ${rhsNrows})`);
        }
        if (thisNcols !== rhsNcols) {
            throw Error(`this.ncols must be equal to rhs.ncols (found ${thisNcols} and ${rhsNcols})`);
        }
        const binSize = getBinSize(this.field.ORDER - 1n);
        const data = [];
        for (let i = 0; i < thisNrows; ++i) {
            const row = [];
            for (let j = 0; j < thisNcols; ++j) {
                if (ct) {
                    const sum = ctAdd(this.data[i][j], rhs.data[i][j], binSize);
                    row.push(ctSelect(ctLt(sum, this.field.ORDER, binSize), sum, ctSub(sum, this.field.ORDER, binSize), binSize));
                }
                else {
                    row.push(this.field.add(this.data[i][j], rhs.data[i][j]));
                }
            }
            data.push(row);
        }
        return new Matrix(this.field, data);
    }
    /**
     * Element-wise subtraction between `this` and `rhs`.
     */
    sub(rhs, ct = false) {
        const thisNrows = this.data.length;
        const thisNcols = this.data[0].length;
        const rhsNrows = rhs.data.length;
        const rhsNcols = rhs.data[0].length;
        if (thisNrows !== rhsNrows) {
            throw Error(`this.nrows must be equal to rhs.nrows (found ${thisNrows} and ${rhsNrows})`);
        }
        if (thisNcols !== rhsNcols) {
            throw Error(`this.ncols must be equal to rhs.ncols (found ${thisNcols} and ${rhsNcols})`);
        }
        const binSize = getBinSize(this.field.ORDER - 1n);
        const data = [];
        for (let i = 0; i < thisNrows; ++i) {
            const row = [];
            for (let j = 0; j < thisNcols; ++j) {
                if (ct) {
                    const diff = ctSub(this.data[i][j], rhs.data[i][j], binSize);
                    row.push(ctSelect(ctSignBit(diff, binSize), ctAdd(diff, this.field.ORDER, binSize), diff, binSize));
                }
                else {
                    row.push(this.field.sub(this.data[i][j], rhs.data[i][j]));
                }
            }
            data.push(row);
        }
        return new Matrix(this.field, data);
    }
    /**
     * Raises each element of `this` to the power `e`.
     */
    pow(e) {
        const data = [];
        for (let i = 0; i < this.data.length; ++i) {
            const row = [];
            for (let j = 0; j < this.data[0].length; ++j) {
                row.push(this.field.pow(this.data[i][j], e));
            }
            data.push(row);
        }
        return new Matrix(this.field, data);
    }
    /**
     * computs the determinant using gaus elimination
     * matches the determinant implementation in arcis
     */
    det() {
        // Ensure the matrix is square
        const n = this.data.length;
        if (n === 0 || !this.is_square()) {
            throw Error('Matrix must be square and non-empty to compute the determinant.');
        }
        let det = this.field.ONE;
        // Clone the data to avoid mutating the original matrix
        let rows = this.data.map((row) => [...row]);
        for (let i = 0; i < n; ++i) {
            // we partition into rows that have a leading zero and rows that don't
            const lzRows = rows.filter((r) => this.field.is0(r[0]));
            const nlzRows = rows.filter((r) => !this.field.is0(r[0]));
            // take pivot element
            const pivotRow = nlzRows.shift();
            if (pivotRow === undefined) {
                // no pivot row implies the rank is less than n i.e. the determinant is zero
                return this.field.ZERO;
            }
            const pivot = pivotRow[0];
            // multiply pivot onto the determinant
            det = this.field.mul(det, pivot);
            // subtract all leading non zero values with the pivot element (forward elimination).
            const pivotInverse = this.field.inv(pivot);
            // precomputing pivot row such that the leading value is one. This reduces the number of
            // multiplications in the forward elimination multiplications by 50%
            const normalizedPivotRow = pivotRow.map((v) => this.field.mul(pivotInverse, v));
            // forward elimination with normalized pivot row
            const nlzRowsProcessed = nlzRows.map((row) => {
                const lead = row[0];
                return row.map((value, index) => this.field.sub(value, this.field.mul(lead, normalizedPivotRow[index])));
            });
            // concat the reamining rows (without pivot row) and remove the pivot column (all first
            // elements (i.e. zeros) from the remaining rows).
            rows = nlzRowsProcessed.concat(lzRows).map((row) => row.slice(1));
        }
        return det;
    }
    is_square() {
        const n = this.data.length;
        for (let i = 1; i < n; ++i) {
            if (this.data[i].length !== n) {
                return false;
            }
        }
        return true;
    }
}
function randMatrix(field, nrows, ncols) {
    const data = [];
    for (let i = 0; i < nrows; ++i) {
        const row = [];
        for (let j = 0; j < ncols; ++j) {
            row.push(generateRandomFieldElem(field.ORDER));
        }
        data.push(row);
    }
    return new Matrix(field, data);
}

/**
 * Curve25519 base field as an IField instance.
 */
const CURVE25519_BASE_FIELD = ed25519.CURVE.Fp;
// hardcode security level to 128 bits
const SECURITY_LEVEL = 128;
// We refer to https://tosc.iacr.org/index.php/ToSC/article/view/8695/8287 for more details.
/**
 * Description and parameters for the Rescue cipher or hash function, including round constants, MDS matrix, and key schedule.
 * See: https://tosc.iacr.org/index.php/ToSC/article/view/8695/8287
 */
class RescueDesc {
    mode;
    field;
    // The smallest prime that does not divide p-1.
    alpha;
    // The inverse of alpha modulo p-1.
    alphaInverse;
    nRounds;
    m;
    // A Maximum Distance Separable matrix.
    mdsMat;
    // Its inverse.
    mdsMatInverse;
    // The round keys, needed for encryption and decryption.
    roundKeys;
    /**
     * Constructs a RescueDesc for a given field and mode (cipher or hash).
     * Initializes round constants, MDS matrix, and key schedule.
     * @param field - The field to use (e.g., CURVE25519_BASE_FIELD).
     * @param mode - The mode: block cipher or hash function.
     */
    constructor(field, mode) {
        this.field = field;
        this.mode = mode;
        switch (this.mode.kind) {
            case 'cipher': {
                this.m = this.mode.key.length;
                if (this.m < 2) {
                    throw Error(`parameter m must be at least 2 (found ${this.m})`);
                }
                break;
            }
            case 'hash': {
                this.m = this.mode.m;
                break;
            }
            default: {
                this.m = 0;
                break;
            }
        }
        const alphaAndInverse = getAlphaAndInverse(this.field.ORDER);
        this.alpha = alphaAndInverse[0];
        this.alphaInverse = alphaAndInverse[1];
        this.nRounds = getNRounds(this.field.ORDER, this.mode, this.alpha, this.m);
        const mdsMatrixAndInverse = getMdsMatrixAndInverse(this.field, this.m);
        this.mdsMat = mdsMatrixAndInverse[0];
        this.mdsMatInverse = mdsMatrixAndInverse[1];
        // generate the round constants using SHAKE256
        const roundConstants = this.sampleConstants(this.nRounds);
        switch (this.mode.kind) {
            case 'cipher': {
                // do the key schedule
                this.roundKeys = rescuePermutation(this.mode, this.alpha, this.alphaInverse, this.mdsMat, roundConstants, new Matrix(this.field, toVec(this.mode.key)));
                break;
            }
            case 'hash': {
                this.roundKeys = roundConstants;
                break;
            }
            default: {
                this.roundKeys = [];
                break;
            }
        }
    }
    /**
     * Samples round constants for the Rescue permutation, using SHAKE256.
     * @param nRounds - The number of rounds.
     * @returns An array of round constant matrices.
     */
    sampleConstants(nRounds) {
        const field = this.field;
        const m = this.m;
        // setup randomness
        // dkLen is the output length from the Keccak instance behind shake.
        // this is irrelevant for our extendable output function (xof), but still we use
        // the default value from one-time shake256 hashing, as defined in shake256's definition
        // in noble-hashes-sha3.
        const hasher = shake256.create({ dkLen: 256 / 8 });
        // buffer to create field elements from bytes
        // we add 16 bytes to get a distribution statistically close to uniform
        const bufferLen = Math.ceil(field.BITS / 8) + 16;
        switch (this.mode.kind) {
            case 'cipher': {
                hasher.update('encrypt everything, compute anything');
                const rFieldArray = Array.from({ length: m * m + 2 * m }, () => {
                    // create field element from the shake hash
                    const randomness = hasher.xof(bufferLen);
                    // we need not check whether the obtained field element f is in any subgroup,
                    // because we use only prime fields (i.e. there are no subgroups)
                    return field.create(deserializeLE(randomness));
                });
                // create matrix and vectors
                const matData = Array.from({ length: m }, () => rFieldArray.splice(0, m));
                let roundConstantMat = new Matrix(field, matData);
                const initData = Array.from({ length: m }, () => rFieldArray.splice(0, 1));
                const initialRoundConstant = new Matrix(field, initData);
                const roundData = Array.from({ length: m }, () => rFieldArray.splice(0, 1));
                const roundConstantAffineTerm = new Matrix(field, roundData);
                // check for inversability
                while (field.is0(roundConstantMat.det())) {
                    // resample matrix
                    const resampleArray = Array.from({ length: m * m }, () => {
                        const randomness = hasher.xof(bufferLen);
                        return field.create(deserializeLE(randomness));
                    });
                    const resampleData = Array.from({ length: m }, () => resampleArray.splice(0, m));
                    roundConstantMat = new Matrix(field, resampleData);
                }
                const roundConstants = [initialRoundConstant];
                for (let r = 0; r < 2 * this.nRounds; ++r) {
                    roundConstants.push(roundConstantMat.matMul(roundConstants[r]).add(roundConstantAffineTerm));
                }
                return roundConstants;
            }
            case 'hash': {
                hasher.update(`Rescue-XLIX(${this.field.ORDER},${m},${this.mode.capacity},${SECURITY_LEVEL})`);
                // this.permute requires an odd number of round keys
                // prepending a 0 matrix makes it equivalent to Algorithm 3 from https://eprint.iacr.org/2020/1143.pdf
                const zeros = [];
                for (let i = 0; i < m; ++i) {
                    zeros.push([0n]);
                }
                const roundConstants = [new Matrix(field, zeros)];
                const rFieldArray = Array.from({ length: 2 * m * nRounds }, () => {
                    // create field element from the shake hash
                    const randomness = hasher.xof(bufferLen);
                    // we need not check whether the obtained field element f is in any subgroup,
                    // because we use only prime fields (i.e. there are no subgroups)
                    return field.create(deserializeLE(randomness));
                });
                for (let r = 0; r < 2 * nRounds; ++r) {
                    const data = [];
                    for (let i = 0; i < m; ++i) {
                        data.push([rFieldArray[r * m + i]]);
                    }
                    roundConstants.push(new Matrix(field, data));
                }
                return roundConstants;
            }
            default: return [];
        }
    }
    /**
     * Applies the Rescue permutation to a state matrix.
     * @param state - The input state matrix.
     * @returns The permuted state matrix.
     */
    permute(state) {
        return rescuePermutation(this.mode, this.alpha, this.alphaInverse, this.mdsMat, this.roundKeys, state)[2 * this.nRounds];
    }
    /**
     * Applies the inverse Rescue permutation to a state matrix.
     * @param state - The input state matrix.
     * @returns The inverse-permuted state matrix.
     */
    permuteInverse(state) {
        return rescuePermutationInverse(this.mode, this.alpha, this.alphaInverse, this.mdsMatInverse, this.roundKeys, state)[2 * this.nRounds];
    }
}
function getAlphaAndInverse(p) {
    const pMinusOne = p - 1n;
    let alpha = 0n;
    for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n]) {
        if (pMinusOne % a !== 0n) {
            alpha = a;
            break;
        }
    }
    if (alpha === 0n) {
        throw Error('Could not find prime alpha that does not divide p-1.');
    }
    const alphaInverse = invert(alpha, pMinusOne);
    return [alpha, alphaInverse];
}
function getNRounds(p, mode, alpha, m) {
    function dcon(n) {
        return Math.floor(0.5 * (Number(alpha) - 1) * m * (n - 1) + 2.0);
    }
    function v(n, rate) {
        return m * (n - 1) + rate;
    }
    function binomial(n, k) {
        function factorial(x) {
            if (x === 0n || x === 1n) {
                return 1n;
            }
            return x * factorial(x - 1n);
        }
        return factorial(BigInt(n)) / (factorial(BigInt(n - k)) * factorial(BigInt(k)));
    }
    switch (mode.kind) {
        case 'cipher': {
            const l0 = Math.ceil((2 * SECURITY_LEVEL) / ((m + 1) * (Math.log2(Number(p)) - Math.log2(Number(alpha) - 1))));
            let l1 = 0;
            if (alpha === 3n) {
                l1 = Math.ceil((SECURITY_LEVEL + 2) / (4 * m));
            }
            else {
                l1 = Math.ceil((SECURITY_LEVEL + 3) / (5.5 * m));
            }
            return 2 * Math.max(l0, l1, 5);
        }
        case 'hash': {
            // get number of rounds for Groebner basis attack
            const rate = m - mode.capacity;
            const target = 1n << BigInt(SECURITY_LEVEL);
            let l1 = 1;
            let tmp = binomial(v(l1, rate) + dcon(l1), v(l1, rate));
            while (tmp * tmp <= target && l1 <= 23) {
                l1 += 1;
                tmp = binomial(v(l1, rate) + dcon(l1), v(l1, rate));
            }
            // set a minimum value for sanity and add 50%
            return Math.ceil(1.5 * Math.max(5, l1));
        }
        default: return 0;
    }
}
function buildCauchy(field, size) {
    const data = [];
    for (let i = 1n; i <= size; ++i) {
        const row = [];
        for (let j = 1n; j <= size; ++j) {
            row.push(field.inv(i + j));
        }
        data.push(row);
    }
    return new Matrix(field, data);
}
function buildInverseCauchy(field, size) {
    function product(arr) {
        return arr.reduce((acc, curr) => field.mul(acc, field.create(curr)), field.ONE);
    }
    function prime(arr, val) {
        return product(arr.map((u) => {
            if (u !== val) {
                return val - u;
            }
            return 1n;
        }));
    }
    const data = [];
    for (let i = 1n; i <= size; ++i) {
        const row = [];
        for (let j = 1n; j <= size; ++j) {
            const a = product(Array.from({ length: size }, (_, key) => -i - BigInt(1 + key)));
            const aPrime = prime(Array.from({ length: size }, (_, key) => BigInt(1 + key)), j);
            const b = product(Array.from({ length: size }, (_, key) => j + BigInt(1 + key)));
            const bPrime = prime(Array.from({ length: size }, (_, key) => -BigInt(1 + key)), -i);
            row.push(field.mul(a, field.mul(b, field.mul(field.inv(aPrime), field.mul(field.inv(bPrime), field.inv(-i - j))))));
        }
        data.push(row);
    }
    return new Matrix(field, data);
}
function getMdsMatrixAndInverse(field, m) {
    const mdsMat = buildCauchy(field, m);
    const mdsMatInverse = buildInverseCauchy(field, m);
    return [mdsMat, mdsMatInverse];
}
function exponentForEven(mode, alpha, alphaInverse) {
    switch (mode.kind) {
        case 'cipher': {
            return alphaInverse;
        }
        case 'hash': {
            return alpha;
        }
        default: return 0n;
    }
}
function exponentForOdd(mode, alpha, alphaInverse) {
    switch (mode.kind) {
        case 'cipher': {
            return alpha;
        }
        case 'hash': {
            return alphaInverse;
        }
        default: return 0n;
    }
}
function rescuePermutation(mode, alpha, alphaInverse, mdsMat, subkeys, state) {
    const exponentEven = exponentForEven(mode, alpha, alphaInverse);
    const exponentOdd = exponentForOdd(mode, alpha, alphaInverse);
    const states = [state.add(subkeys[0])];
    for (let r = 0; r < subkeys.length - 1; ++r) {
        let s = states[r];
        if (r % 2 === 0) {
            s = s.pow(exponentEven);
        }
        else {
            s = s.pow(exponentOdd);
        }
        states.push(mdsMat.matMul(s).add(subkeys[r + 1]));
    }
    return states;
}
function rescuePermutationInverse(mode, alpha, alphaInverse, mdsMatInverse, subkeys, state) {
    const exponentEven = exponentForEven(mode, alpha, alphaInverse);
    const exponentOdd = exponentForOdd(mode, alpha, alphaInverse);
    // the initial state will need to be removed afterwards
    const states = [state];
    for (let r = 0; r < subkeys.length - 1; ++r) {
        let s = states[r];
        s = mdsMatInverse.matMul(s.sub(subkeys[subkeys.length - 1 - r]));
        if (r % 2 === 0) {
            s = s.pow(exponentEven);
        }
        else {
            s = s.pow(exponentOdd);
        }
        states.push(s);
    }
    states.push(states[states.length - 1].sub(subkeys[0]));
    states.shift();
    return states;
}
function toVec(data) {
    const dataVec = [];
    for (let i = 0; i < data.length; ++i) {
        dataVec.push([data[i]]);
    }
    return dataVec;
}

/**
 * The Rescue-Prime hash function, as described in https://eprint.iacr.org/2020/1143.pdf.
 * Used with fixed m = 6 and capacity = 1 (rate = 5). According to Section 2.2, this offers log2(CURVE25519_BASE_FIELD.ORDER) / 2 bits of security against collision, preimage, and second-preimage attacks.
 * See the referenced paper for further details.
 */
class RescuePrimeHash {
    desc;
    rate;
    /**
     * Constructs a RescuePrimeHash instance with m = 6 and capacity = 1.
     */
    constructor() {
        this.desc = new RescueDesc(CURVE25519_BASE_FIELD, { kind: 'hash', m: 6, capacity: 1 });
        this.rate = 6 - 1;
    }
    // This is Algorithm 1 from https://eprint.iacr.org/2020/1143.pdf, though with the padding (see Algorithm 2).
    // The hash function outputs this.rate elements.
    /**
     * Computes the Rescue-Prime hash of a message, with padding as described in Algorithm 2 of the paper.
     * @param message - The input message as an array of bigints.
     * @returns The hash output as an array of bigints (length = rate).
     */
    digest(message) {
        message.push(1n);
        while (message.length % this.rate !== 0) {
            message.push(0n);
        }
        const zeros = [];
        for (let i = 0; i < this.desc.m; ++i) {
            zeros.push([0n]);
        }
        let state = new Matrix(this.desc.field, zeros);
        for (let r = 0; r < message.length / this.rate; ++r) {
            const data = [];
            for (let i = 0; i < this.rate; ++i) {
                data[i] = [message[r * this.rate + i]];
            }
            for (let i = this.rate; i < this.desc.m; ++i) {
                data[i] = [0n];
            }
            const s = new Matrix(this.desc.field, data);
            state = this.desc.permute(state.add(s, true));
        }
        const res = [];
        for (let i = 0; i < this.rate; ++i) {
            res.push(state.data[i][0]);
        }
        return res;
    }
}

/**
 * HMACRescuePrime provides a message authentication code (MAC) using the Rescue-Prime hash function.
 * We refer to https://datatracker.ietf.org/doc/html/rfc2104 for more details.
 */
class HMACRescuePrime {
    hasher;
    /**
     * Constructs a new HMACRescuePrime instance.
     */
    constructor() {
        this.hasher = new RescuePrimeHash();
    }
    /**
     * Computes the HMAC digest of a message with a given key using Rescue-Prime.
     * @param key - The key as an array of bigints.
     * @param message - The message as an array of bigints.
     * @returns The HMAC digest as an array of bigints.
     * @throws Error if the key is longer than the hash function's rate.
     */
    digest(key, message) {
        // We follow https://datatracker.ietf.org/doc/html/rfc2104, though since Rescue-Prime is not based
        // on the Merkle-Damgard construction we cannot have an exact anology between the
        // parameters. For our purpose, we set B = L = hasher.rate.
        if (key.length > this.hasher.rate) {
            throw Error(`length of key is supposed to be at most the hash function's rate (found ${key.length} and ${this.hasher.rate})`);
        }
        const ipad = deserializeLE(new Uint8Array(32).fill(0x36));
        const opad = deserializeLE(new Uint8Array(32).fill(0x5c));
        // the key is first extended to length B
        for (let i = 0; i < this.hasher.rate - key.length; ++i) {
            key.push(0n);
        }
        // inner padding
        const keyPlusIpad = key.map((k) => k + ipad);
        keyPlusIpad.push(...message);
        const innerDigest = this.hasher.digest(keyPlusIpad);
        // outer padding
        const keyPlusOpad = key.map((k) => k + opad);
        keyPlusOpad.push(...innerDigest);
        return this.hasher.digest(keyPlusOpad);
    }
}

/**
 * HKDF (HMAC-based Extract-and-Expand Key Derivation Function) using the Rescue-Prime hash function.
 * Follows RFC 5869. Only supports L = HashLen.
 */
class HKDFRescuePrime {
    hmac;
    /**
     * Constructs a new HKDFRescuePrime instance.
     */
    constructor() {
        this.hmac = new HMACRescuePrime();
    }
    /**
     * HKDF-Extract step: derives a pseudorandom key (PRK) from the input keying material (IKM) and salt.
     * @param salt - The salt value as an array of bigints.
     * @param ikm - The input keying material as an array of bigints.
     * @returns The pseudorandom key (PRK) as an array of bigints.
     */
    extract(salt, ikm) {
        if (salt.length === 0) {
            // HashLen = hasher.rate for Rescue-Prime
            for (let i = 0; i < this.hmac.hasher.rate; ++i) {
                salt.push(0n);
            }
        }
        return this.hmac.digest(salt, ikm);
    }
    /**
     * HKDF-Expand step: expands the pseudorandom key (PRK) with info to produce output keying material (OKM).
     * Only supports L = HashLen = 5, i.e. N = 1.
     * @param prk - The pseudorandom key as an array of bigints.
     * @param info - The context and application specific information as an array of bigints.
     * @returns The output keying material (OKM) as an array of bigints.
     */
    expand(prk, info) {
        // we only support L = HashLen = 5, i.e. N = 1
        // message = empty string | info | 0x01
        info.push(1n);
        return this.hmac.digest(prk, info);
    }
    /**
     * Performs the full HKDF (extract and expand) to derive output keying material (OKM).
     * @param salt - The salt value as an array of bigints.
     * @param ikm - The input keying material as an array of bigints.
     * @param info - The context and application specific information as an array of bigints.
     * @returns The output keying material (OKM) as an array of bigints.
     */
    okm(salt, ikm, info) {
        const prk = this.extract(salt, ikm);
        return this.expand(prk, info);
    }
}

/**
 * The Rescue cipher in Counter (CTR) mode, with a fixed block size m = 5.
 * See: https://tosc.iacr.org/index.php/ToSC/article/view/8695/8287
 */
class RescueCipher {
    desc;
    /**
     * Constructs a RescueCipher instance using a shared secret.
     * The key is derived using HKDF-RescuePrime and used to initialize the RescueDesc.
     * @param sharedSecret - The shared secret to derive the cipher key from.
     */
    constructor(sharedSecret) {
        const hkdf = new HKDFRescuePrime();
        const rescueKey = hkdf.okm([], [deserializeLE(sharedSecret)], []);
        this.desc = new RescueDesc(CURVE25519_BASE_FIELD, { kind: 'cipher', key: rescueKey });
    }
    /**
     * Encrypts the plaintext vector in Counter (CTR) mode (raw, returns bigints).
     * @param plaintext - The array of plaintext bigints to encrypt.
     * @param nonce - A 16-byte nonce for CTR mode.
     * @returns The ciphertext as an array of bigints.
     * @throws Error if the nonce is not 16 bytes long.
     */
    encrypt_raw(plaintext, nonce) {
        if (nonce.length !== 16) {
            throw Error(`nonce must be of length 16 (found ${nonce.length})`);
        }
        const binSize = getBinSize(this.desc.field.ORDER - 1n);
        function encryptBatch(desc, ptxt, cntr) {
            if (cntr.length !== 5) {
                throw Error(`counter must be of length 5 (found ${cntr.length})`);
            }
            const encryptedCounter = desc.permute(new Matrix(desc.field, toVec(cntr)));
            const ciphertext = [];
            for (let i = 0; i < ptxt.length; ++i) {
                if (!verifyBinSize(ptxt[i], binSize - 1n) || ctSignBit(ptxt[i], binSize) || !ctLt(ptxt[i], desc.field.ORDER, binSize)) {
                    throw Error(`plaintext must be non-negative and at most ${desc.field.ORDER}`);
                }
                const sum = ctAdd(ptxt[i], encryptedCounter.data[i][0], binSize);
                ciphertext.push(ctSelect(ctLt(sum, desc.field.ORDER, binSize), sum, ctSub(sum, desc.field.ORDER, binSize), binSize));
            }
            return ciphertext;
        }
        const nBlocks = Math.ceil(plaintext.length / 5);
        const counter = getCounter(deserializeLE(nonce), nBlocks);
        const ciphertext = [];
        for (let i = 0; i < nBlocks; ++i) {
            const cnt = 5 * i;
            const newCiphertext = encryptBatch(this.desc, plaintext.slice(cnt, Math.min(cnt + 5, plaintext.length)), counter.slice(cnt, cnt + 5));
            for (let j = 0; j < newCiphertext.length; ++j) {
                ciphertext.push(newCiphertext[j]);
            }
        }
        return ciphertext;
    }
    /**
     * Encrypts the plaintext vector in Counter (CTR) mode and serializes each block.
     * @param plaintext - The array of plaintext bigints to encrypt.
     * @param nonce - A 16-byte nonce for CTR mode.
     * @returns The ciphertext as an array of arrays of numbers (each 32 bytes).
     */
    encrypt(plaintext, nonce) {
        return this.encrypt_raw(plaintext, nonce).map((c) => Array.from(serializeLE(c, 32)));
    }
    /**
     * Decrypts the ciphertext vector in Counter (CTR) mode (raw, expects bigints).
     * @param ciphertext - The array of ciphertext bigints to decrypt.
     * @param nonce - A 16-byte nonce for CTR mode.
     * @returns The decrypted plaintext as an array of bigints.
     * @throws Error if the nonce is not 16 bytes long.
     */
    decrypt_raw(ciphertext, nonce) {
        if (nonce.length !== 16) {
            throw Error(`nonce must be of length 16 (found ${nonce.length})`);
        }
        const binSize = getBinSize(this.desc.field.ORDER - 1n);
        function decryptBatch(desc, ctxt, cntr) {
            if (cntr.length !== 5) {
                throw Error(`counter must be of length 5 (found ${cntr.length})`);
            }
            const encryptedCounter = desc.permute(new Matrix(desc.field, toVec(cntr)));
            const decrypted = [];
            for (let i = 0; i < ctxt.length; ++i) {
                const diff = ctSub(ctxt[i], encryptedCounter.data[i][0], binSize);
                decrypted.push(ctSelect(ctSignBit(diff, binSize), ctAdd(diff, desc.field.ORDER, binSize), diff, binSize));
            }
            return decrypted;
        }
        const nBlocks = Math.ceil(ciphertext.length / 5);
        const counter = getCounter(deserializeLE(nonce), nBlocks);
        const decrypted = [];
        for (let i = 0; i < nBlocks; ++i) {
            const cnt = 5 * i;
            const newDecrypted = decryptBatch(this.desc, ciphertext.slice(cnt, Math.min(cnt + 5, ciphertext.length)), counter.slice(cnt, cnt + 5));
            for (let j = 0; j < newDecrypted.length; ++j) {
                decrypted.push(newDecrypted[j]);
            }
        }
        return decrypted;
    }
    /**
     * Deserializes and decrypts the ciphertext vector in Counter (CTR) mode.
     * @param ciphertext - The array of arrays of numbers (each 32 bytes) to decrypt.
     * @param nonce - A 16-byte nonce for CTR mode.
     * @returns The decrypted plaintext as an array of bigints.
     */
    decrypt(ciphertext, nonce) {
        return this.decrypt_raw(ciphertext.map((c) => {
            if (c.length !== 32) {
                throw Error(`ciphertext must be of length 32 (found ${c.length})`);
            }
            return deserializeLE(Uint8Array.from(c));
        }), nonce);
    }
}
/**
 * Generates the counter values for Rescue cipher CTR mode.
 * @param nonce - The initial nonce as a bigint.
 * @param nBlocks - The number of blocks to generate counters for.
 * @returns An array of counter values as bigints.
 */
function getCounter(nonce, nBlocks) {
    const counter = [];
    for (let i = 0n; i < nBlocks; ++i) {
        counter.push(nonce);
        counter.push(i);
        counter.push(0n);
        counter.push(0n);
        counter.push(0n);
    }
    return counter;
}


// Export RescueCipher for use in tests
export { RescueCipher };
