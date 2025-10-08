pass=0
fail=0
for i in {1..5}; do
  echo ""
  echo "🚀 Run $i of 5"

  # Clean test ledger to prevent state persistence between runs
  rm -rf .anchor/test-ledger

  arcium build
  if arcium test; then
    echo "✅ PASS"
    ((pass++))
  else
    echo "❌ FAIL"
    ((fail++))
  fi
  echo ""
done
echo ""
echo "📊 Results: ✅ $pass passes, ❌ $fail failures"
