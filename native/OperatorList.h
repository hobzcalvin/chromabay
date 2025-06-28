#pragma once

/*
 * OPERATOR LIST
 * =============
 * 
 * This file includes all available operator implementations.
 * Each operator should include BaseOperator.h individually.
 * 
 * To add a new operator:
 * 1. Create YourOperator.h that extends BaseOperator
 * 2. Add REGISTER_OPERATOR(YourOperator) at the end of your .h file
 * 3. Add #include "YourOperator.h" below
 * 4. Recompile - your operator will be automatically available!
 */

// ========================================
// INCLUDE ALL OPERATORS HERE
// ========================================

#include "NoiseBlendOperator.h"

// Add your new operators here:
// #include "RainbowOperator.h"
// #include "SolidColorOperator.h"
// #include "YourCustomOperator.h" 